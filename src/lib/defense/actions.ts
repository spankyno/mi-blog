// src/lib/defense/actions.ts
// ─────────────────────────────────────────────────────────────────────────────
// Operaciones de defensa compartidas por el panel y por el bot de Telegram,
// para que ambos hagan exactamente lo mismo (y queden auditadas igual).
// ─────────────────────────────────────────────────────────────────────────────
import { LEVELS, type DefenseLevel } from './config';
import { invalidateState } from './cache';
import { ipv6Slash64, parseIp } from './ip';
import { addBlock, getSetting, logEvent, setSetting } from './store';

type DB = any;
export type Via = 'panel' | 'telegram';

export async function currentLevel(db: DB): Promise<DefenseLevel> {
  const n = parseInt((await getSetting(db, 'defense_level')) ?? '0', 10);
  return (Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0) as DefenseLevel;
}

/** Cambia el nivel (0–3). Si se entra en mantenimiento, recuerda el nivel previo. */
export async function applyLevel(db: DB, level: DefenseLevel, who: string | null, via: Via): Promise<void> {
  const current = await currentLevel(db);
  if (level === 3 && current !== 3) await setSetting(db, 'defense_prev_level', String(current));
  await setSetting(db, 'defense_level', String(level));
  await logEvent(db, 'level', who, `Nivel → ${level} (${LEVELS[level].name}) [${via}]`);
  invalidateState();
}

export async function applyMaintenance(
  db: DB,
  on: boolean,
  opts: { message?: string; eta?: string },
  who: string | null,
  via: Via
): Promise<DefenseLevel> {
  let result: DefenseLevel;
  if (on) {
    if (opts.message) await setSetting(db, 'maintenance_message', opts.message);
    if (opts.eta !== undefined) await setSetting(db, 'maintenance_eta', opts.eta);
    const current = await currentLevel(db);
    if (current !== 3) await setSetting(db, 'defense_prev_level', String(current));
    await setSetting(db, 'defense_level', '3');
    result = 3;
    await logEvent(db, 'maintenance', who, `Mantenimiento ACTIVADO${opts.eta ? ` (ETA ${opts.eta})` : ''} [${via}]`);
  } else {
    const prev = parseInt((await getSetting(db, 'defense_prev_level')) ?? '0', 10);
    const restore = (Number.isInteger(prev) && prev >= 0 && prev <= 2 ? prev : 0) as DefenseLevel;
    await setSetting(db, 'defense_level', String(restore));
    result = restore;
    await logEvent(db, 'maintenance', who, `Mantenimiento DESACTIVADO → nivel ${restore} [${via}]`);
  }
  invalidateState();
  return result;
}

/** Añade un bloqueo manual de una IP (IPv6: todo su /64). Devuelve lo que se bloqueó. */
export async function applyBan(
  db: DB,
  ipText: string,
  minutes: number,
  reason: string,
  who: string | null,
  via: Via
): Promise<{ kind: 'ip' | 'cidr'; value: string } | null> {
  const ip = parseIp(ipText);
  if (!ip) return null;
  const kind = ip.family === 6 ? ('cidr' as const) : ('ip' as const);
  const value = ip.family === 6 ? ipv6Slash64(ip)! : ip.text;
  await addBlock(db, {
    kind,
    value,
    reason,
    source: via === 'telegram' ? 'telegram' : 'manual',
    expiresAt: minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
  });
  await logEvent(db, 'block_add', who, `${kind}:${value} (${minutes > 0 ? `${minutes} min` : 'permanente'}) [${via}]`);
  invalidateState();
  return { kind, value };
}
