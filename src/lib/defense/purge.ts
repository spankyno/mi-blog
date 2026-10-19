// src/lib/defense/purge.ts
// ─────────────────────────────────────────────────────────────────────────────
// Poda de datos antiguos. Borra por tandas (RETENTION.maxRowsPerTable) para no
// agotar las 100.000 escrituras diarias de D1 de golpe.
// ─────────────────────────────────────────────────────────────────────────────
import { RETENTION } from './config';

type DB = any;

export interface PurgeCounts {
  botViews: number;
  humanViews: number;
  botIps: number;
  events: number;
  hourly: number;
  expiredBlocks: number;
}

const iso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function cutoffs() {
  return {
    botViews: iso(RETENTION.botViewsDays),
    humanViews: iso(RETENTION.humanViewsDays),
    events: iso(RETENTION.eventsDays),
    hourly: iso(RETENTION.hourlyDays).slice(0, 13),
    expiredBlocks: iso(RETENTION.expiredBlocksDays),
  };
}

async function count(db: DB, sql: string, ...params: unknown[]): Promise<number> {
  const r = await db.prepare(sql).bind(...params).first().catch(() => null);
  return (r as any)?.n ?? 0;
}

/** Cuántas filas se borrarían (para la vista previa del panel). */
export async function previewPurge(db: DB): Promise<PurgeCounts> {
  const c = cutoffs();
  const [botViews, humanViews, botIps, events, hourly, expiredBlocks] = await Promise.all([
    count(db, `SELECT COUNT(*) AS n FROM page_views WHERE is_bot = 1 AND viewed_at < ?`, c.botViews),
    count(db, `SELECT COUNT(*) AS n FROM page_views WHERE is_bot = 0 AND viewed_at < ?`, c.humanViews),
    count(db, `SELECT COUNT(*) AS n FROM bot_ips WHERE detected_at < datetime('now', '-${RETENTION.botIpsDays} days')`),
    count(db, `SELECT COUNT(*) AS n FROM defense_events WHERE ts < ?`, c.events),
    count(db, `SELECT COUNT(*) AS n FROM defense_hourly WHERE hour < ?`, c.hourly),
    count(db, `SELECT COUNT(*) AS n FROM blocked_ips WHERE expires_at IS NOT NULL AND expires_at < ?`, c.expiredBlocks),
  ]);
  return { botViews, humanViews, botIps, events, hourly, expiredBlocks };
}

async function del(db: DB, sql: string, ...params: unknown[]): Promise<number> {
  const r = await db.prepare(sql).bind(...params).run().catch(() => null);
  return (r as any)?.meta?.changes ?? 0;
}

/** Ejecuta la poda. Devuelve cuántas filas borró de cada tabla. */
export async function runPurge(db: DB): Promise<PurgeCounts> {
  const c = cutoffs();
  const L = RETENTION.maxRowsPerTable;
  const botViews = await del(db, `DELETE FROM page_views WHERE id IN (SELECT id FROM page_views WHERE is_bot = 1 AND viewed_at < ? LIMIT ${L})`, c.botViews);
  const humanViews = await del(db, `DELETE FROM page_views WHERE id IN (SELECT id FROM page_views WHERE is_bot = 0 AND viewed_at < ? LIMIT ${L})`, c.humanViews);
  const botIps = await del(db, `DELETE FROM bot_ips WHERE ip IN (SELECT ip FROM bot_ips WHERE detected_at < datetime('now', '-${RETENTION.botIpsDays} days') LIMIT ${L})`);
  const events = await del(db, `DELETE FROM defense_events WHERE id IN (SELECT id FROM defense_events WHERE ts < ? LIMIT ${L})`, c.events);
  const hourly = await del(db, `DELETE FROM defense_hourly WHERE hour < ?`, c.hourly);
  const expiredBlocks = await del(db, `DELETE FROM blocked_ips WHERE id IN (SELECT id FROM blocked_ips WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ${L})`, c.expiredBlocks);
  return { botViews, humanViews, botIps, events, hourly, expiredBlocks };
}

/**
 * Poda automática opcional, como mucho una vez al día. Solo UN isolate la
 * ejecuta: se «reclama» el día con un UPDATE condicional en `settings`.
 */
export async function maybeAutoPurge(db: DB): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const claim = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('defense_last_purge', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value < excluded.value`
    )
    .bind(today)
    .run()
    .catch(() => null);
  if (((claim as any)?.meta?.changes ?? 0) < 1) return; // otro isolate ya lo hizo hoy
  await runPurge(db);
}
