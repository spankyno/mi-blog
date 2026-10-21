// src/lib/defense/alerts.ts
// ─────────────────────────────────────────────────────────────────────────────
// Detección de ataque y alertas por Telegram con botones de acción.
//
// Sin cron (Pages no tiene): las alertas salen del propio flujo de visitas.
//  · Ráfaga: una IP (o /64) supera N visitas en 60 s.
//  · Oleada: más de N visitas de bots en 5 minutos.
// Anti-duplicados entre isolates: cada tipo de alerta «reclama» su hueco con un
// UPDATE condicional en `settings`; solo el isolate que lo gana envía el aviso.
// Coste: una escritura en D1 como mucho una vez por cooldown y isolate.
// ─────────────────────────────────────────────────────────────────────────────
import { LEVELS, type DefenseLevel } from './config';
import { invalidateState } from './cache';
import { ipv6Slash64, type ParsedIp } from './ip';
import { hit } from './rate-limiter';
import { getSetting, logEvent, setSetting, type DefenseState } from './store';
import { esc, sendMessage, type Keyboard, type TgEnv } from './telegram-api';

type DB = any;
export type AlertKind = 'ip' | 'wave';

const lastAttempt: Partial<Record<AlertKind, number>> = {};

/** Unidad que se cuenta: IPv4 exacta o /64 en IPv6. */
export function unitOf(ip: ParsedIp): string {
  return ip.family === 6 ? ipv6Slash64(ip)! : ip.text;
}

/** Qué ha hecho una IP en el último minuto (en memoria de este servidor). */
export interface Trail {
  first: number;                 // primera petición de la racha (ms)
  last: number;                  // última petición (ms)
  paths: Map<string, number>;    // ruta → nº de peticiones
  ua: string;                    // User-Agent (recortado)
}

const trails = new Map<string, Trail>();
const MAX_TRAILS = 2000;
const MAX_PATHS_PER_TRAIL = 12;

/** Fecha y hora en Madrid, p. ej. «20/10/2026 14:33:07». */
export function madridTime(ms: number): string {
  return new Date(ms).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(',', '');
}

function recordTrail(unit: string, path: string, ua: string | null, now: number): Trail {
  let t = trails.get(unit);
  if (!t || now - t.last > 60_000) {
    if (trails.size >= MAX_TRAILS) trails.clear();
    t = { first: now, last: now, paths: new Map(), ua: '' };
    trails.set(unit, t);
  }
  t.last = now;
  const key = t.paths.has(path) || t.paths.size < MAX_PATHS_PER_TRAIL ? path : '(otras rutas)';
  t.paths.set(key, (t.paths.get(key) ?? 0) + 1);
  if (!t.ua && ua) t.ua = ua.slice(0, 120);
  return t;
}

/** «/blog/x ×12, / ×10, …» con las rutas más visitadas (ya escapado para Telegram HTML). */
export function topPathsText(t: Trail, max = 4): string {
  return [...t.paths.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([p, n]) => `<code>${esc(p.length > 60 ? p.slice(0, 57) + '…' : p)}</code> ×${n}`)
    .join(', ');
}

/**
 * Registra una visita de esa IP; si supera el umbral de ráfaga, devuelve el nº de
 * visitas/60 s y el rastro (páginas, hora y navegador) para detallar la alerta.
 */
export function ipBurst(
  state: DefenseState,
  ip: ParsedIp,
  req?: { path: string; ua: string | null }
): { count: number; trail?: Trail } | null {
  const unit = unitOf(ip);
  const now = Date.now();
  const n = hit(`alert|ip|${unit}`, 60_000, now);
  const trail = req ? recordTrail(unit, req.path, req.ua, now) : undefined;
  return n > state.alerts.ipPerMin ? { count: Math.round(n), trail } : null;
}

/** Registra una visita de bot; devuelve el nº de visitas/5 min si supera el umbral. */
export function botWave(state: DefenseState): number | null {
  const n = hit('alert|wave', 300_000);
  return n > state.alerts.wave5min ? Math.round(n) : null;
}

/** Botones de acción rápida. `lvl:N`, `mnt:on|yes|off`, `ban:<ip>`, `ign`. */
export function actionKeyboard(level: number, ipText?: string): Keyboard {
  const rows: Keyboard = [];
  if (ipText) rows.push([{ text: '🚫 Bloquear IP (24 h)', callback_data: `ban:${ipText}` }]);
  const second: Keyboard[number] = [];
  if (level < 2) second.push({ text: '🛡 Subir a Defensa', callback_data: 'lvl:2' });
  if (level < 3) second.push({ text: '🔧 Mantenimiento', callback_data: 'mnt:on' });
  else second.push({ text: '✅ Salir de mantenimiento', callback_data: 'mnt:off' });
  rows.push(second);
  rows.push([{ text: 'Ignorar', callback_data: 'ign' }]);
  return rows;
}

export function levelLine(level: number): string {
  const l = LEVELS[level as DefenseLevel];
  return `🛡 Nivel actual: ${level} · ${esc(l?.name ?? '?')}`;
}

export async function sendAlert(a: {
  kind: AlertKind;
  db: DB;
  env: TgEnv;
  state: DefenseState;
  count: number;
  ip?: ParsedIp;
  geo?: { country?: string | null; asn?: number | null; org?: string | null };
  trail?: Trail;
}): Promise<void> {
  const { kind, db, env, state } = a;
  try {
    if (!state.alerts.enabled || state.telegramMuted) return;
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

    const now = Date.now();
    const cooldownMs = state.alerts.cooldownMin * 60_000;
    if (now - (lastAttempt[kind] ?? 0) < cooldownMs) return; // filtro barato en memoria
    lastAttempt[kind] = now;

    // Reclamar el hueco: solo un isolate envía el aviso dentro del cooldown.
    const claim = await db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(value AS INTEGER) < ?`
      )
      .bind(`defense_last_alert_${kind}`, String(now), now - cooldownMs)
      .run()
      .catch(() => null);
    if (((claim as any)?.meta?.changes ?? 0) < 1) return;

    // Escalada automática opcional: solo de 0 a 1 (Vigilancia), que nunca bloquea.
    let level: number = state.level;
    let escalated = false;
    if (state.alerts.autoEscalate && state.level === 0) {
      await setSetting(db, 'defense_level', '1');
      await logEvent(db, 'level', 'auto', 'Nivel → 1 (Vigilancia) [escalada automática por alerta]');
      invalidateState();
      level = 1;
      escalated = true;
    }

    const lines: string[] = [];
    let keyboard: Keyboard;
    if (kind === 'ip' && a.ip) {
      const place = [a.geo?.country, a.geo?.asn ? `AS${a.geo.asn}` : null, a.geo?.org].filter(Boolean).join(' · ');
      lines.push('🚨 <b>Ráfaga desde una IP</b>', '─────────────────', `🔗 IP: <code>${esc(unitOf(a.ip))}</code>`);
      if (place) lines.push(`🌍 ${esc(place)}`);
      lines.push(`📈 ${a.count} visitas en 60 s (umbral ${state.alerts.ipPerMin})`);
      if (a.trail && a.trail.paths.size > 0) {
        lines.push(`📄 Páginas: ${topPathsText(a.trail)}`);
        lines.push(`🕒 ${madridTime(a.trail.first)} → ${madridTime(a.trail.last).slice(11)} (hora de Madrid)`);
        if (a.trail.ua) lines.push(`🖥 <code>${esc(a.trail.ua)}</code>`);
      } else {
        lines.push(`🕒 ${madridTime(now)} (hora de Madrid)`);
      }
      keyboard = actionKeyboard(level, a.ip.text);
    } else {
      lines.push('🚨 <b>Oleada de bots</b>', '─────────────────', `📈 ${a.count} visitas de bots en 5 min (umbral ${state.alerts.wave5min})`);
      lines.push(`🕒 ${madridTime(now)} (hora de Madrid)`);
      keyboard = actionKeyboard(level);
    }
    lines.push(levelLine(level));
    if (escalated) lines.push('⬆️ Subido automáticamente a Vigilancia (no bloquea).');
    if (state.alerts.cooldownMin) lines.push(`🔕 Próximo aviso de este tipo en ${state.alerts.cooldownMin} min como mínimo.`);

    await sendMessage(env, lines.join('\n'), keyboard);
    const pagesDetail = a.trail && a.trail.paths.size > 0
      ? ` · ${[...a.trail.paths.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([p, n]) => `${p} ×${n}`).join(', ')}`
      : '';
    await logEvent(db, 'alert', a.ip ? unitOf(a.ip) : null, `${kind === 'ip' ? 'Ráfaga' : 'Oleada'}: ${a.count}${pagesDetail}`);
  } catch (e) {
    console.error('defense: error enviando alerta:', e);
  }
}

/** Aviso corto de cambios de nivel/mantenimiento hechos desde el panel. */
export async function notifyChange(env: TgEnv, db: DB, text: string): Promise<void> {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
    if ((await getSetting(db, 'telegram_enabled')) === '0') return;
    if ((await getSetting(db, 'defense_notify_changes')) === '0') return;
    await sendMessage(env, text);
  } catch (e) {
    console.error('defense: error en notifyChange:', e);
  }
}
