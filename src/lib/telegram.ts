// ─── Tipos ────────────────────────────────────────────────────────────────────

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
