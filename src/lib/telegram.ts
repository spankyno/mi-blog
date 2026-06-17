// ─── Tipos ────────────────────────────────────────────────────────────────────

interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  DB?: D1Database;
}

interface VisitaData {
  slug: string;
  title: string;       // necesario para generar la imagen OG
  ip: string | null;
  city: string | null;
  country: string | null;
  userAgent: string | null;
  viewedAt: string; // ISO
}

interface ComentarioData {
  slug: string;
  title: string;       // necesario para generar la imagen OG
  autor: string;
  email: string | null;
  contenido: string;
  ip: string | null;
  city: string | null;
  country: string | null;
  createdAt: string; // ISO
}

interface ContactoData {
  nombre: string;
  email: string;
  asunto: string;
  comentario: string;
  ip: string | null;
  city: string | null;
  country: string | null;
  fechaHora: string; // ISO
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

/** Formatea una fecha ISO a "DD/MM/YYYY HH:MM h" en hora de Madrid. */
function formatFecha(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).replace(',', '') + ' h';
  } catch {
    return iso;
  }
}

/** Devuelve la IP tal cual, o "desconocida" si es nula. */
function formatIp(ip: string | null): string {
  return ip ?? 'desconocida';
}

/** Extrae "Chrome / Android" del User-Agent. */
function parseUA(ua: string | null): string {
  if (!ua) return 'Desconocido';

  let browser = 'Otro';
  if (/Edg\//i.test(ua))          browser = 'Edge';
  else if (/OPR\//i.test(ua))     browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua))  browser = 'Chrome';
  else if (/Safari\//i.test(ua))  browser = 'Safari';

  let os = 'Otro';
  if (/Android/i.test(ua))          os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua))     os = 'Windows';
  else if (/Mac OS X/i.test(ua))    os = 'macOS';
  else if (/Linux/i.test(ua))       os = 'Linux';

  return `${browser} / ${os}`;
}

/** Trunca un texto a N caracteres añadiendo "…" si es necesario. */
function truncate(text: string, max = 120): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

/** Genera la URL de la imagen OG de Cloudinary para un título dado. */
function buildOgImageUrl(title: string): string {
  const CLOUD_NAME = 'kalbo';
  const OG_BASE_ID = 'foto-portada_ddtnbq';

  const safeTitle = encodeURIComponent(
    title
      .replace(/,/g, ' ')
      .replace(/\//g, ' ')
      .slice(0, 80)
  );

  const layers = [
    'w_1200,h_630,c_fill',
    'e_gradient_fade,y_-0.5,b_rgb:080e1a',
    `l_text:Arial_40_bold:${safeTitle},co_rgb:f5f2ec,g_south_west,x_80,y_100,w_900,c_fit`,
    'l_text:Arial_22:aitorsanchez.pages.dev,co_rgb:c9a84c,g_south_west,x_80,y_54',
    'l_text:Arial_20:Aitor%20Sa%CC%81nchez%20Guti%C3%A9rrez,co_rgb:ffffff80,g_south_west,x_80,y_26',
  ].join('/');

  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${layers}/${OG_BASE_ID}.webp`;
}

// ─── Comprobación de flag en D1 ───────────────────────────────────────────────

/**
 * Devuelve true si los avisos de Telegram están activados en D1.
 * Si la tabla o la clave no existen, devuelve true (activado por defecto).
 */
async function isTelegramEnabled(db: D1Database | undefined): Promise<boolean> {
  if (!db) return true;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'telegram_enabled' LIMIT 1`)
      .first<{ value: string }>();
    if (!row) return true;
    return row.value !== '0';
  } catch {
    return true;
  }
}

// ─── Envío a la Bot API ───────────────────────────────────────────────────────

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    console.error('[Telegram] sendMessage error:', await res.text());
  }
}

/**
 * Envía una foto con caption usando sendPhoto.
 * Si la imagen falla, cae a sendMessage con solo el texto.
 */
async function sendPhoto(
  token: string,
  chatId: string,
  photoUrl: string,
  caption: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'HTML',
    }),
  });
  if (!res.ok) {
    console.error('[Telegram] sendPhoto error:', await res.text());
    // Fallback: enviar solo el texto si la foto falla
    await sendMessage(token, chatId, caption);
  }
}

// ─── Funciones públicas ───────────────────────────────────────────────────────

/**
 * Avisa de una visita a un post.
 * Solo se llama cuando is_bot === 0 (comprobado antes de llamar a esta función).
 */
export async function sendTelegramVisita(
  env: TelegramEnv,
  data: VisitaData
): Promise<void> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, DB: db } = env;
  if (!token || !chatId) return;
  if (!await isTelegramEnabled(db)) return;

  const ubicacion = [data.city, data.country].filter(Boolean).join(', ') || 'Desconocida';
  const dispositivo = parseUA(data.userAgent);
  const fecha = formatFecha(data.viewedAt);
  const ip = formatIp(data.ip);

  const caption = [
    '<b>Visita en blog</b>',
    '─────────────────',
    `📄 ${data.slug}`,
    `🕐 ${fecha}`,
    `🌍 ${ubicacion}`,
    `📱 ${dispositivo}`,
    `🔗 IP: ${ip}`,
  ].join('\n');

  const ogUrl = buildOgImageUrl(data.title);
  await sendPhoto(token, chatId, ogUrl, caption);
}

/**
 * Avisa de un comentario nuevo (estado: pendiente).
 */
export async function sendTelegramComentario(
  env: TelegramEnv,
  data: ComentarioData
): Promise<void> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, DB: db } = env;
  if (!token || !chatId) return;
  if (!await isTelegramEnabled(db)) return;

  const ubicacion = [data.city, data.country].filter(Boolean).join(', ') || 'Desconocida';
  const fecha = formatFecha(data.createdAt);
  const ip = formatIp(data.ip);
  const preview = truncate(data.contenido, 120);

  const caption = [
    '<b>Comentario nuevo</b>',
    '─────────────────',
    `📄 ${data.slug}`,
    `👤 ${data.autor}`,
    data.email ? `✉️ ${data.email}` : null,
    `💬 "${preview}"`,
    `🕐 ${fecha}`,
    `🌍 ${ubicacion}`,
    `🔗 IP: ${ip}`,
  ].filter(Boolean).join('\n');

  const ogUrl = buildOgImageUrl(data.title);
  await sendPhoto(token, chatId, ogUrl, caption);
}

/**
 * Avisa de un mensaje del formulario de contacto.
 * Sin imagen OG (no hay post asociado).
 */
export async function sendTelegramContacto(
  env: TelegramEnv,
  data: ContactoData
): Promise<void> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, DB: db } = env;
  if (!token || !chatId) return;
  if (!await isTelegramEnabled(db)) return;

  const ubicacion = [data.city, data.country].filter(Boolean).join(', ') || 'Desconocida';
  const fecha = formatFecha(data.fechaHora);
  const ip = formatIp(data.ip);
  const preview = truncate(data.comentario, 120);

  const text = [
    '<b>Mensaje de contacto</b>',
    '─────────────────',
    `👤 ${data.nombre}`,
    `✉️ ${data.email}`,
    `📋 ${data.asunto}`,
    `💬 "${preview}"`,
    `🕐 ${fecha}`,
    `🌍 ${ubicacion}`,
    `🔗 IP: ${ip}`,
  ].join('\n');

  await sendMessage(token, chatId, text);
}


interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  DB?: D1Database;
}

interface VisitaData {
  slug: string;
  ip: string | null;
  city: string | null;
  country: string | null;
  userAgent: string | null;
  viewedAt: string; // ISO
}

interface ComentarioData {
  slug: string;
  autor: string;
  email: string | null;
  contenido: string;
  ip: string | null;
  city: string | null;
  country: string | null;
  createdAt: string; // ISO
}

interface ContactoData {
  nombre: string;
  email: string;
  asunto: string;
  comentario: string;
  ip: string | null;
  city: string | null;
  country: string | null;
  fechaHora: string; // ISO
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

/** Formatea una fecha ISO a "DD/MM/YYYY HH:MM h" en hora de Madrid. */
function formatFecha(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).replace(',', '') + ' h';
  } catch {
    return iso;
  }
}

/** Enmascara la IP: "82.12.34.56" → "82.xxx.xxx.xxx" */
function maskIp(ip: string | null): string {
  if (!ip) return 'desconocida';
  const v4 = ip.match(/^(\d+)\.\d+\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.xxx.xxx.xxx`;
  // IPv6: muestra solo los dos primeros grupos
  const v6parts = ip.split(':');
  if (v6parts.length > 2) return `${v6parts[0]}:${v6parts[1]}:xxxx:xxxx`;
  return 'xxx';
}

/** Extrae "Chrome / Android" del User-Agent. */
function parseUA(ua: string | null): string {
  if (!ua) return 'Desconocido';

  let browser = 'Otro';
  if (/Edg\//i.test(ua))         browser = 'Edge';
  else if (/OPR\//i.test(ua))    browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua))  browser = 'Chrome';
  else if (/Safari\//i.test(ua))  browser = 'Safari';

  let os = 'Otro';
  if (/Android/i.test(ua))        os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua))   os = 'Windows';
  else if (/Mac OS X/i.test(ua))  os = 'macOS';
  else if (/Linux/i.test(ua))     os = 'Linux';

  return `${browser} / ${os}`;
}

/** Trunca un texto a N caracteres añadiendo "…" si es necesario. */
function truncate(text: string, max = 120): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

// ─── Comprobación de flag en D1 ───────────────────────────────────────────────

/**
 * Devuelve true si los avisos de Telegram están activados en D1.
 * Si la tabla o la clave no existen, devuelve true (activado por defecto).
 */
async function isTelegramEnabled(db: D1Database | undefined): Promise<boolean> {
  if (!db) return true;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'telegram_enabled' LIMIT 1`)
      .first<{ value: string }>();
    // Si la fila no existe aún, consideramos activado
    if (!row) return true;
    return row.value !== '0';
  } catch {
    return true;
  }
}

// ─── Envío a la Bot API ───────────────────────────────────────────────────────

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[Telegram] Error al enviar mensaje:', err);
  }
}

// ─── Funciones públicas ───────────────────────────────────────────────────────

/**
 * Avisa de una visita a un post.
 * Solo se llama cuando is_bot === 0 (comprobado antes de llamar a esta función).
 */
export async function sendTelegramVisita(
  env: TelegramEnv,
  data: VisitaData
): Promise<void> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, DB: db } = env;
  if (!token || !chatId) return;
  if (!await isTelegramEnabled(db)) return;

  const ubicacion = [data.city, data.country].filter(Boolean).join(', ') || 'Desconocida';
  const dispositivo = parseUA(data.userAgent);
  const fecha = formatFecha(data.viewedAt);
  const ip = maskIp(data.ip);

  const text = [
    '<b>Visita en blog</b>',
    '─────────────────',
    `📄 ${data.slug}`,
    `🕐 ${fecha}`,
    `🌍 ${ubicacion}`,
    `📱 ${dispositivo}`,
    `🔗 IP: ${ip}`,
  ].join('\n');

  await sendMessage(token, chatId, text);
}

/**
 * Avisa de un comentario nuevo (estado: pendiente).
 */
export async function sendTelegramComentario(
  env: TelegramEnv,
  data: ComentarioData
): Promise<void> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, DB: db } = env;
  if (!token || !chatId) return;
  if (!await isTelegramEnabled(db)) return;

  const ubicacion = [data.city, data.country].filter(Boolean).join(', ') || 'Desconocida';
  const fecha = formatFecha(data.createdAt);
  const ip = maskIp(data.ip);
  const preview = truncate(data.contenido, 120);

  const text = [
    '<b>Comentario nuevo</b>',
    '─────────────────',
    `📄 ${data.slug}`,
    `👤 ${data.autor}`,
    data.email ? `✉️ ${data.email}` : null,
    `💬 "${preview}"`,
    `🕐 ${fecha}`,
    `🌍 ${ubicacion}`,
    `🔗 IP: ${ip}`,
  ].filter(Boolean).join('\n');

  await sendMessage(token, chatId, text);
}

/**
 * Avisa de un mensaje del formulario de contacto.
 */
export async function sendTelegramContacto(
  env: TelegramEnv,
  data: ContactoData
): Promise<void> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, DB: db } = env;
  if (!token || !chatId) return;
  if (!await isTelegramEnabled(db)) return;

  const ubicacion = [data.city, data.country].filter(Boolean).join(', ') || 'Desconocida';
  const fecha = formatFecha(data.fechaHora);
  const ip = maskIp(data.ip);
  const preview = truncate(data.comentario, 120);

  const text = [
    '<b>Mensaje de contacto</b>',
    '─────────────────',
    `👤 ${data.nombre}`,
    `✉️ ${data.email}`,
    `📋 ${data.asunto}`,
    `💬 "${preview}"`,
    `🕐 ${fecha}`,
    `🌍 ${ubicacion}`,
    `🔗 IP: ${ip}`,
  ].join('\n');

  await sendMessage(token, chatId, text);
}
