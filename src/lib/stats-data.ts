// src/lib/stats-data.ts
// ─────────────────────────────────────────────────────────────────────────────
// Consultas a D1 del dashboard de estadísticas. Una sola pasada por tabla para
// cada bloque y siempre acotadas por rango (usa idx_page_views_time):
//   1 KPIs (periodo actual + anterior) · 1 serie · 1 posts · 1 países ·
//   2 tabla (conteo + página) · 1 títulos  →  7 consultas, 6 en paralelo.
// ─────────────────────────────────────────────────────────────────────────────
import {
  PAGE_SIZE, bucketSql, fillSeries, resolvePeriod,
  type Period, type RankRow, type SeriesPoint, type StatsQuery, type Totals,
} from './stats';

interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): { all(): Promise<{ results?: any[] }>; first(): Promise<any> };
  };
}

export interface VisitRow {
  slug: string;
  country: string | null;
  city: string | null;
  viewed_at: string;
  is_bot: number;
  user_agent: string | null;
}

export interface StatsData {
  period: Period;
  cur: Totals;
  prev: Totals;
  series: SeriesPoint[];
  /** Ordenados por visitas del modo activo (humanas si "solo humanos", si no totales). */
  posts: RankRow[];
  countries: RankRow[];
  rows: VisitRow[];
  rowsTotal: number;
  page: number;
  pages: number;
  titles: Record<string, string>;
}

const iso = (d: Date) => d.toISOString();
const empty = (): Totals => ({ total: 0, humans: 0, bots: 0, posts: 0, countries: 0 });
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function toTotals(r: any): Totals {
  const total = r?.total ?? 0;
  const humans = r?.humans ?? 0;
  return { total, humans, bots: Math.max(total - humans, 0), posts: r?.posts ?? 0, countries: r?.countries ?? 0 };
}

export async function loadStats(db: D1Like, q: StatsQuery, now: Date = new Date()): Promise<StatsData> {
  const period = resolvePeriod(q, now);
  const from = iso(period.from);
  const to = iso(period.to);
  const humanOnly = q.humans ? ` AND is_bot = 0` : '';

  // Filtros de la tabla (todos con parámetros enlazados; nada se concatena salvo constantes).
  const w: string[] = [`viewed_at >= ?`, `viewed_at < ?`];
  const wp: unknown[] = [from, to];
  if (q.kind === 'human') w.push(`is_bot = 0`);
  if (q.kind === 'bot') w.push(`is_bot = 1`);
  if (q.post) { w.push(`slug = ?`); wp.push(q.post); }
  if (q.country) { w.push(`country = ?`); wp.push(q.country); }
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    w.push(`(slug LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\')`);
    wp.push(like, like);
  }
  const where = w.join(' AND ');

  const [kpi, series, posts, countries, count] = await Promise.all([
    db.prepare(
      `SELECT (viewed_at >= ?) AS cur, COUNT(*) AS total, SUM(is_bot = 0) AS humans,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN slug END) AS posts,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN country END) AS countries
       FROM page_views
       WHERE (viewed_at >= ? AND viewed_at < ?) OR (viewed_at >= ? AND viewed_at < ?)
       GROUP BY cur`,
    ).bind(from, from, to, iso(period.prevFrom), iso(period.prevTo)).all(),

    db.prepare(
      `SELECT ${bucketSql(period.granularity)} AS b, SUM(is_bot = 0) AS h, COUNT(*) AS t
       FROM page_views WHERE viewed_at >= ? AND viewed_at < ?${humanOnly}
       GROUP BY b ORDER BY b`,
    ).bind(from, to).all(),

    // LIMIT 100: margen para que los insights encuentren el mejor post humano aunque no esté en el top 10 por total.
    db.prepare(
      `SELECT slug AS key, SUM(is_bot = 0) AS h, COUNT(*) AS t
       FROM page_views WHERE viewed_at >= ? AND viewed_at < ?${humanOnly}
       GROUP BY slug ORDER BY ${q.humans ? 'h' : 't'} DESC, slug LIMIT 100`,
    ).bind(from, to).all(),

    db.prepare(
      `SELECT country AS key, SUM(is_bot = 0) AS h, COUNT(*) AS t
       FROM page_views WHERE viewed_at >= ? AND viewed_at < ? AND country IS NOT NULL${humanOnly}
       GROUP BY country ORDER BY ${q.humans ? 'h' : 't'} DESC, country LIMIT 50`,
    ).bind(from, to).all(),

    db.prepare(`SELECT COUNT(*) AS n FROM page_views WHERE ${where}`).bind(...wp).first(),
  ]);

  let cur = empty();
  let prev = empty();
  for (const r of kpi.results ?? []) (r.cur ? (cur = toTotals(r)) : (prev = toTotals(r)));

  const rank = (rs: any[] | undefined): RankRow[] => (rs ?? []).map((r) => ({ key: String(r.key), h: r.h ?? 0, b: Math.max((r.t ?? 0) - (r.h ?? 0), 0) }));

  const rowsTotal: number = count?.n ?? 0;
  const pages = Math.max(Math.ceil(rowsTotal / PAGE_SIZE), 1);
  const page = Math.min(q.page, pages);
  const rowsRes = await db.prepare(
    `SELECT slug, country, city, viewed_at, is_bot, user_agent FROM page_views
     WHERE ${where} ORDER BY viewed_at DESC LIMIT ? OFFSET ?`,
  ).bind(...wp, PAGE_SIZE, (page - 1) * PAGE_SIZE).all();
  const rows = (rowsRes.results ?? []) as VisitRow[];

  const rankedPosts = rank(posts.results);

  // Títulos de los posts mostrados (top 10 + mejor humano + filas de la tabla).
  const slugs = [...new Set([
    ...rankedPosts.slice(0, 10).map((p) => p.key),
    ...[...rankedPosts].sort((a, b) => b.h - a.h).slice(0, 1).map((p) => p.key),
    ...rows.map((r) => r.slug),
    ...(q.post ? [q.post] : []),
  ])].filter(Boolean);
  const titles: Record<string, string> = {};
  if (slugs.length) {
    try {
      const t = await db.prepare(`SELECT slug, title FROM posts WHERE slug IN (${slugs.map(() => '?').join(',')})`).bind(...slugs).all();
      for (const r of t.results ?? []) titles[r.slug] = r.title;
    } catch { /* sin títulos: se muestra el slug */ }
  }

  return {
    period, cur, prev, rows, rowsTotal, page, pages, titles,
    series: fillSeries((series.results ?? []).map((r) => ({ b: r.b, h: r.h ?? 0, t: r.t ?? 0 })), period.from, period.to, period.granularity),
    posts: rankedPosts,
    countries: rank(countries.results),
  };
}
