// src/lib/defense/store.ts
// ─────────────────────────────────────────────────────────────────────────────
// Acceso a D1: carga del estado y operaciones de escritura del panel.
// Cada lectura va en su propio try/catch: si falta una tabla (migración sin
// ejecutar) el módulo sigue funcionando con lo que haya (fail open).
// ─────────────────────────────────────────────────────────────────────────────
import {
  ALERT_DEFAULTS,
  AUTOBAN_DEFAULTS,
  DEFAULTS,
  ENFORCEABLE_SCOPES,
  HONEYPOT_DAYS,
  MAX_ALLOW_ROWS,
  MAX_BLOCK_ROWS,
  MAX_HONEYPOT_ROWS,
  MAX_RULES,
  type DefenseLevel,
  type EntryKind,
  type EntrySource,
  type Rule,
  type RuleAction,
  type RuleScope,
} from './config';
import { addToList, emptyList, type CompiledList } from './blocklist';

type DB = any; // D1Database

export interface DefenseState {
  enabled: boolean;
  level: DefenseLevel;
  maintenanceMessage: string;
  maintenanceEta: string | null;
  blocks: CompiledList;
  allows: CompiledList;
  rules: Rule[];
  autoBan: { enabled: boolean; hits: number; windowMin: number; hours: number };
  liteSkipLogging: boolean;
  autoPurge: boolean;
  alerts: { enabled: boolean; ipPerMin: number; wave5min: number; cooldownMin: number; autoEscalate: boolean; notifyChanges: boolean };
  /** Interruptor global de Telegram del panel (botón «Telegram ✓/✗»). */
  telegramMuted: boolean;
  loadedAt: number;
}

function intSetting(v: string | undefined, def: number, min: number, max: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

function clampLevel(v: unknown): DefenseLevel {
  const n = parseInt(String(v ?? ''), 10);
  return (Number.isFinite(n) && n >= 0 && n <= 3 ? n : DEFAULTS.level) as DefenseLevel;
}

export async function loadState(db: DB): Promise<DefenseState> {
  const nowIso = new Date().toISOString();

  const [settingsR, blocksR, allowsR, honeyR, rulesR] = await Promise.all([
    db
      .prepare(
        `SELECT key, value FROM settings WHERE key IN
         ('defense_enabled','defense_level','maintenance_message','maintenance_eta',
          'defense_auto_ban','defense_autoban_hits','defense_autoban_window_min','defense_autoban_hours',
          'defense_lite_skip_logging','defense_auto_purge',
          'defense_alerts_enabled','defense_alert_ip_per_min','defense_alert_wave_5min',
          'defense_alert_cooldown_min','defense_auto_escalate','defense_notify_changes','telegram_enabled')`
      )
      .all()
      .catch(() => null),
    db
      .prepare(
        `SELECT id, kind, value, source, reason FROM blocked_ips
         WHERE expires_at IS NULL OR expires_at > ? LIMIT ${MAX_BLOCK_ROWS}`
      )
      .bind(nowIso)
      .all()
      .catch(() => null),
    db
      .prepare(`SELECT id, kind, value FROM allow_list LIMIT ${MAX_ALLOW_ROWS}`)
      .all()
      .catch(() => null),
    db
      .prepare(
        `SELECT ip FROM bot_ips
         WHERE detected_at >= datetime('now', '-${HONEYPOT_DAYS} days') LIMIT ${MAX_HONEYPOT_ROWS}`
      )
      .all()
      .catch(() => null),
    db
      .prepare(
        `SELECT id, name, scope, path_pattern, max_hits, window_s, action, ban_minutes
         FROM defense_rules WHERE enabled = 1 ORDER BY id LIMIT ${MAX_RULES}`
      )
      .all()
      .catch(() => null),
  ]);

  const settings: Record<string, string> = {};
  for (const r of (settingsR?.results ?? []) as any[]) settings[r.key] = String(r.value);

  const blocks = emptyList();
  // Honeypot primero: una entrada manual de la misma IP la sobrescribe.
  for (const r of (honeyR?.results ?? []) as any[]) {
    addToList(blocks, { kind: 'ip', value: String(r.ip), source: 'honeypot', reason: 'Honeypot /trap' });
  }
  for (const r of (blocksR?.results ?? []) as any[]) {
    addToList(blocks, {
      id: r.id,
      kind: r.kind as EntryKind,
      value: String(r.value),
      source: (r.source ?? 'manual') as EntrySource,
      reason: r.reason ?? null,
    });
  }

  const allows = emptyList();
  for (const r of (allowsR?.results ?? []) as any[]) {
    addToList(allows, { id: r.id, kind: r.kind as EntryKind, value: String(r.value), source: 'manual' });
  }

  const rules: Rule[] = [];
  for (const r of (rulesR?.results ?? []) as any[]) {
    const scope = String(r.scope) as RuleScope;
    if (!['ip', 'ua', 'asn', 'global'].includes(scope)) continue;
    let action = String(r.action) as RuleAction;
    if (!['flag', 'limit', 'ban'].includes(action)) action = 'flag';
    // UA y global nunca bloquean, solo avisan.
    if (!ENFORCEABLE_SCOPES.includes(scope)) action = 'flag';
    rules.push({
      id: r.id,
      name: String(r.name),
      scope,
      pathPattern: String(r.path_pattern || '*'),
      maxHits: Math.max(1, Number(r.max_hits) || 1),
      windowS: Math.min(3600, Math.max(5, Number(r.window_s) || 60)),
      action,
      banMinutes: Math.min(10_080, Math.max(1, Number(r.ban_minutes) || 15)),
    });
  }

  return {
    rules,
    autoBan: {
      enabled: settings['defense_auto_ban'] !== '0' && AUTOBAN_DEFAULTS.enabled,
      hits: intSetting(settings['defense_autoban_hits'], AUTOBAN_DEFAULTS.hits, 2, 100),
      windowMin: intSetting(settings['defense_autoban_window_min'], AUTOBAN_DEFAULTS.windowMin, 1, 1440),
      hours: intSetting(settings['defense_autoban_hours'], AUTOBAN_DEFAULTS.hours, 1, 8760),
    },
    alerts: {
      enabled: settings['defense_alerts_enabled'] !== '0' && ALERT_DEFAULTS.enabled,
      ipPerMin: intSetting(settings['defense_alert_ip_per_min'], ALERT_DEFAULTS.ipPerMin, 5, 10_000),
      wave5min: intSetting(settings['defense_alert_wave_5min'], ALERT_DEFAULTS.wave5min, 5, 100_000),
      cooldownMin: intSetting(settings['defense_alert_cooldown_min'], ALERT_DEFAULTS.cooldownMin, 1, 1440),
      autoEscalate: settings['defense_auto_escalate'] === '1',
      notifyChanges: settings['defense_notify_changes'] !== '0',
    },
    telegramMuted: settings['telegram_enabled'] === '0',
    liteSkipLogging: settings['defense_lite_skip_logging'] === '1',
    autoPurge: settings['defense_auto_purge'] === '1',
    enabled: settings['defense_enabled'] !== '0',
    level: clampLevel(settings['defense_level']),
    maintenanceMessage: settings['maintenance_message'] || DEFAULTS.maintenanceMessage,
    maintenanceEta: settings['maintenance_eta'] || null,
    blocks,
    allows,
    loadedAt: Date.now(),
  };
}

// ── Escrituras (las usa la API del panel) ───────────────────────────────────

export async function setSetting(db: DB, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, value)
    .run();
}

export async function getSetting(db: DB, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = ? LIMIT 1`)
    .bind(key)
    .first()
    .catch(() => null);
  return row ? String((row as any).value) : null;
}

export async function logEvent(db: DB, type: string, ip: string | null, detail: string): Promise<void> {
  await db
    .prepare(`INSERT INTO defense_events (ts, type, ip, detail) VALUES (?, ?, ?, ?)`)
    .bind(new Date().toISOString(), type, ip, detail.slice(0, 500))
    .run()
    .catch(() => null);
}

export async function addBlock(
  db: DB,
  e: { kind: EntryKind; value: string; reason?: string; source?: EntrySource; expiresAt?: string | null }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO blocked_ips (kind, value, reason, source, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET
         reason = excluded.reason, source = excluded.source, expires_at = excluded.expires_at`
    )
    .bind(e.kind, e.value, e.reason ?? null, e.source ?? 'manual', new Date().toISOString(), e.expiresAt ?? null)
    .run();
}

export async function removeBlock(db: DB, id: number): Promise<void> {
  await db.prepare(`DELETE FROM blocked_ips WHERE id = ?`).bind(id).run();
}

export async function addAllow(db: DB, e: { kind: EntryKind; value: string; note?: string }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO allow_list (kind, value, note, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET note = excluded.note`
    )
    .bind(e.kind, e.value, e.note ?? null, new Date().toISOString())
    .run();
}

export async function removeAllow(db: DB, id: number): Promise<void> {
  await db.prepare(`DELETE FROM allow_list WHERE id = ?`).bind(id).run();
}

export async function bumpHourly(
  db: DB,
  hour: string,
  c: { flagged: number; limited: number; blocked: number; maint: number }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO defense_hourly (hour, flagged, limited, blocked, maint) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hour) DO UPDATE SET
         flagged = flagged + excluded.flagged,
         limited = limited + excluded.limited,
         blocked = blocked + excluded.blocked,
         maint   = maint   + excluded.maint`
    )
    .bind(hour, c.flagged, c.limited, c.blocked, c.maint)
    .run();
}


// ── Reglas de frecuencia (CRUD del panel) ───────────────────────────────────

export interface RuleInput {
  name: string;
  scope: RuleScope;
  pathPattern: string;
  maxHits: number;
  windowS: number;
  action: RuleAction;
  banMinutes: number;
  enabled?: boolean;
}

export async function saveRule(db: DB, r: RuleInput, id?: number): Promise<void> {
  if (id) {
    await db
      .prepare(
        `UPDATE defense_rules SET name=?, scope=?, path_pattern=?, max_hits=?, window_s=?, action=?, ban_minutes=?
         WHERE id=?`
      )
      .bind(r.name, r.scope, r.pathPattern, r.maxHits, r.windowS, r.action, r.banMinutes, id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO defense_rules (name, enabled, scope, path_pattern, max_hits, window_s, action, ban_minutes)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
      )
      .bind(r.name, r.scope, r.pathPattern, r.maxHits, r.windowS, r.action, r.banMinutes)
      .run();
  }
}

export async function setRuleEnabled(db: DB, id: number, enabled: boolean): Promise<void> {
  await db.prepare(`UPDATE defense_rules SET enabled = ? WHERE id = ?`).bind(enabled ? 1 : 0, id).run();
}

export async function deleteRule(db: DB, id: number): Promise<void> {
  await db.prepare(`DELETE FROM defense_rules WHERE id = ?`).bind(id).run();
}

export async function countRules(db: DB): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM defense_rules`).first().catch(() => null);
  return (r as any)?.n ?? 0;
}

/** Nº de entradas automáticas vigentes (tope para no llenar la tabla en un ataque). */
export async function countActiveAutoBlocks(db: DB): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM blocked_ips WHERE source = 'auto' AND (expires_at IS NULL OR expires_at > ?)`)
    .bind(new Date().toISOString())
    .first()
    .catch(() => null);
  return (r as any)?.n ?? 0;
}

export const DEFAULT_RULES: RuleInput[] = [
  { name: 'Ráfaga por IP', scope: 'ip', pathPattern: '/blog/*', maxHits: 30, windowS: 60, action: 'ban', banMinutes: 15 },
  { name: 'Mismo UA desde muchas IPs', scope: 'ua', pathPattern: '*', maxHits: 20, windowS: 60, action: 'flag', banMinutes: 15 },
  { name: 'Presión global', scope: 'global', pathPattern: '*', maxHits: 300, windowS: 60, action: 'flag', banMinutes: 15 },
];

/** Inserta las reglas por defecto solo si la tabla está vacía. */
export async function seedDefaultRules(db: DB): Promise<boolean> {
  if ((await countRules(db)) > 0) return false;
  for (const r of DEFAULT_RULES) await saveRule(db, r);
  return true;
}
