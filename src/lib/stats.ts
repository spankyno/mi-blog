// src/lib/stats.ts
// ─────────────────────────────────────────────────────────────────────────────
// Lógica pura del dashboard de estadísticas (/panel/stats): sin D1, sin Astro.
// Todo lo que se puede probar con `npm test` vive aquí; las consultas están en
// stats-data.ts y la presentación en src/components/stats/.
//
// Convención de fechas: `viewed_at` se guarda como ISO UTC (new Date().toISOString()),
// así que comparar cadenas ISO equivale a comparar instantes.
// ─────────────────────────────────────────────────────────────────────────────

export type PeriodKey = 'today' | '7d' | '30d' | '90d' | 'custom';
export type Granularity = 'hour' | 'day' | 'week';
export type Kind = 'all' | 'human' | 'bot';

export const PAGE_SIZE = 15;
export const DEFAULT_PERIOD: PeriodKey = '30d';
const DAY = 86_400_000;
const HOUR = 3_600_000;

export const PERIODS: { key: Exclude<PeriodKey, 'custom'>; label: string; days: number }[] = [
  { key: 'today', label: 'Hoy', days: 1 },
  { key: '7d', label: '7 días', days: 7 },
  { key: '30d', label: '30 días', days: 30 },
  { key: '90d', label: '90 días', days: 90 },
];

// ── Filtros de la URL ───────────────────────────────────────────────────────

export interface StatsQuery {
  p: PeriodKey;
  from: string | null;
  to: string | null;
  /** Granularidad pedida (puede no ser válida para el rango; ver resolvePeriod). */
  g: Granularity | null;
  humans: boolean;
  q: string;
  post: string;
  country: string;
  kind: Kind;
  page: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s: string | null): s is string => !!s && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Sanea los parámetros de la URL: cualquier valor raro cae al valor por defecto. */
export function parseStatsQuery(sp: URLSearchParams): StatsQuery {
  const pRaw = sp.get('p');
  let p: PeriodKey = (['today', '7d', '30d', '90d', 'custom'] as const).includes(pRaw as PeriodKey) ? (pRaw as PeriodKey) : DEFAULT_PERIOD;

  let from: string | null = null;
  let to: string | null = null;
  if (p === 'custom') {
    const f = sp.get('from');
    const t = sp.get('to');
    if (isValidDate(f) && isValidDate(t)) {
      from = f <= t ? f : t;
      to = f <= t ? t : f;
      // Máximo 366 días: protege a D1 de rangos desmesurados.
      const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;
      if (span > 365) to = new Date(Date.parse(`${from}T00:00:00Z`) + 365 * DAY).toISOString().slice(0, 10);
    } else {
      p = DEFAULT_PERIOD;
    }
  }

  const gRaw = sp.get('g');
  const g = gRaw === 'hour' || gRaw === 'day' || gRaw === 'week' ? gRaw : null;

  const humans = sp.get('h') === '1';
  const kRaw = sp.get('k');
  const kind: Kind = humans ? 'human' : kRaw === 'human' || kRaw === 'bot' ? kRaw : 'all';

  const post = (sp.get('post') ?? '').trim();
  const country = (sp.get('c') ?? '').trim().toUpperCase();
  const pageRaw = parseInt(sp.get('pg') ?? '1', 10);

  return {
    p, from, to, g, humans, kind,
    q: (sp.get('q') ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60),
    post: /^[\p{L}\p{N}_-]{1,200}$/u.test(post) ? post : '',
    country: /^[A-Z0-9]{2}$/.test(country) ? country : '',
    page: Number.isFinite(pageRaw) ? Math.min(Math.max(pageRaw, 1), 10_000) : 1,
  };
}

/** Parámetros canónicos de la vista: omite los valores por defecto para mantener los enlaces cortos. */
export function statsParams(q: StatsQuery, patch: Partial<StatsQuery> = {}): URLSearchParams {
  const n: StatsQuery = { ...q, ...patch };
  if (!('page' in patch)) n.page = 1; // cualquier cambio de filtro vuelve a la página 1
  if (n.humans) n.kind = 'human';
  const sp = new URLSearchParams();
  if (n.p !== DEFAULT_PERIOD) sp.set('p', n.p);
  if (n.p === 'custom' && n.from && n.to) { sp.set('from', n.from); sp.set('to', n.to); }
  if (n.g) sp.set('g', n.g);
  if (n.humans) sp.set('h', '1');
  else if (n.kind !== 'all') sp.set('k', n.kind);
  if (n.q) sp.set('q', n.q);
  if (n.post) sp.set('post', n.post);
  if (n.country) sp.set('c', n.country);
  if (n.page > 1) sp.set('pg', String(n.page));
  return sp;
}

/** URL de la vista con cambios aplicados (y ancla opcional). */
export function statsHref(q: StatsQuery, patch: Partial<StatsQuery> = {}, hash = ''): string {
  const qs = statsParams(q, patch).toString();
  return `/panel/stats${qs ? `?${qs}` : ''}${hash}`;
}

// ── Periodo actual y anterior ───────────────────────────────────────────────

export interface Period {
  key: PeriodKey;
  label: string;
  from: Date;
  /** Fin exclusivo. */
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  granularity: Granularity;
  allowed: Record<Granularity, boolean>;
}

const startOfDayUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const fmtShortDate = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Resuelve el rango. La ventana anterior se desplaza un número entero de días,
 * de modo que "Hoy" se compara con ayer a la misma hora (no con el día completo).
 */
export function resolvePeriod(q: StatsQuery, now: Date = new Date()): Period {
  let from: Date;
  let to: Date;
  let days: number;
  let label: string;

  if (q.p === 'custom' && q.from && q.to) {
    from = new Date(`${q.from}T00:00:00Z`);
    const endExclusive = new Date(Date.parse(`${q.to}T00:00:00Z`) + DAY);
    to = endExclusive.getTime() > now.getTime() ? now : endExclusive;
    days = Math.round((endExclusive.getTime() - from.getTime()) / DAY);
    label = `${fmtShortDate.format(from)} – ${fmtShortDate.format(new Date(endExclusive.getTime() - DAY))}`;
  } else {
    const preset = PERIODS.find((x) => x.key === q.p) ?? PERIODS[2];
    days = preset.days;
    from = new Date(startOfDayUTC(now).getTime() - (days - 1) * DAY);
    to = now;
    label = preset.key === 'today' ? 'Hoy' : `Últimos ${days} días`;
  }
  if (to.getTime() < from.getTime()) to = from; // rango totalmente futuro

  const spanDays = Math.max((to.getTime() - from.getTime()) / DAY, 0);
  const allowed: Record<Granularity, boolean> = { hour: spanDays <= 7.01, day: true, week: spanDays >= 14 };
  const auto: Granularity = spanDays <= 1.01 ? 'hour' : spanDays <= 31 ? 'day' : 'week';
  const granularity = q.g && allowed[q.g] ? q.g : auto;

  return {
    key: q.p, label, from, to, granularity, allowed,
    prevFrom: new Date(from.getTime() - days * DAY),
    prevTo: new Date(to.getTime() - days * DAY),
  };
}

// ── Series temporales ───────────────────────────────────────────────────────

export interface SeriesRow { b: string; h: number; t: number }
export interface SeriesPoint { key: string; short: string; long: string; h: number; b: number }

/** Lunes de la semana de una fecha YYYY-MM-DD (igual que date(x,'weekday 0','-6 days') de SQLite). */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = domingo
  return new Date(d.getTime() - ((dow + 6) % 7) * DAY).toISOString().slice(0, 10);
}

/** Expresión SQL que agrupa `viewed_at` en cubos. Constante interna (nunca viene del usuario). */
export function bucketSql(g: Granularity): string {
  if (g === 'hour') return `substr(viewed_at, 1, 13)`;
  if (g === 'day') return `substr(viewed_at, 1, 10)`;
  return `date(substr(viewed_at, 1, 10), 'weekday 0', '-6 days')`;
}

export function bucketKeys(from: Date, to: Date, g: Granularity): string[] {
  const keys: string[] = [];
  if (to.getTime() <= from.getTime()) return keys;
  if (g === 'hour') {
    for (let t = Math.floor(from.getTime() / HOUR) * HOUR; t < to.getTime(); t += HOUR) keys.push(new Date(t).toISOString().slice(0, 13));
  } else if (g === 'day') {
    for (let t = startOfDayUTC(from).getTime(); t < to.getTime(); t += DAY) keys.push(new Date(t).toISOString().slice(0, 10));
  } else {
    const first = new Date(`${mondayOf(from.toISOString().slice(0, 10))}T00:00:00Z`).getTime();
    for (let t = first; t < to.getTime(); t += 7 * DAY) keys.push(new Date(t).toISOString().slice(0, 10));
  }
  return keys;
}

const fDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fDayLong = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function bucketLabels(key: string, g: Granularity): { short: string; long: string } {
  if (g === 'hour') {
    const d = new Date(`${key}:00:00Z`);
    const hh = key.slice(11, 13);
    const next = String((Number(hh) + 1) % 24).padStart(2, '0');
    return { short: `${hh}h`, long: `${fDay.format(d)}, ${hh}:00–${next}:00 UTC` };
  }
  const d = new Date(`${key}T00:00:00Z`);
  if (g === 'week') return { short: fDay.format(d), long: `Semana del ${fDay.format(d)}` };
  return { short: fDay.format(d), long: fDayLong.format(d) };
}

/** Rellena los cubos sin visitas con ceros para que el eje X sea continuo. */
export function fillSeries(rows: SeriesRow[], from: Date, to: Date, g: Granularity): SeriesPoint[] {
  const map = new Map(rows.map((r) => [r.b, r]));
  return bucketKeys(from, to, g).map((key) => {
    const r = map.get(key);
    const h = r?.h ?? 0;
    const t = r?.t ?? 0;
    return { key, ...bucketLabels(key, g), h, b: Math.max(t - h, 0) };
  });
}

// ── Geometría de los gráficos ───────────────────────────────────────────────

/** Máximo "redondo" divisible entre 4 (para 4 líneas de guía enteras). */
export function niceMax(n: number): number {
  if (n <= 4) return 4;
  const raw = n / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag * 4;
}

export type XY = [number, number];

/** Curva suave sin sobreoscilación (tangentes horizontales en los puntos medios). */
export function linePath(pts: XY[]): string {
  if (pts.length === 0) return '';
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = ((x0 + x1) / 2).toFixed(1);
    d += `C${mx} ${y0.toFixed(1)} ${mx} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return d;
}

export function areaPath(pts: XY[], baseY: number): string {
  if (pts.length === 0) return '';
  const line = linePath(pts);
  return `${line}L${pts[pts.length - 1][0].toFixed(1)} ${baseY}L${pts[0][0].toFixed(1)} ${baseY}Z`;
}

/** Puntos (x,y) en un viewBox W×H. Con un solo cubo se dibuja una línea plana de borde a borde. */
export function toPoints(values: number[], max: number, W: number, H: number): XY[] {
  if (values.length === 0) return [];
  const y = (v: number) => H - (Math.min(v, max) / max) * H;
  if (values.length === 1) return [[0, y(values[0])], [W, y(values[0])]];
  return values.map((v, i) => [(i / (values.length - 1)) * W, y(v)] as XY);
}

/** Índices de las etiquetas del eje X (como mucho `max`, siempre con el primero y el último). */
export function tickIndexes(n: number, max = 7): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => Math.round(i * step));
}

// ── Números y deltas ────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('es-ES');
export const fmtInt = (n: number) => nf.format(Math.round(n));
export const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
export const fmtPct = (n: number, digits = 0) => `${n.toFixed(digits).replace('.', ',')}%`;

export interface Delta { dir: 'up' | 'down' | 'flat' | 'new'; label: string }

/** Variación % respecto al periodo anterior. `unit: 'pp'` para diferencias de porcentajes. */
export function delta(cur: number, prev: number, unit: '%' | 'pp' = '%'): Delta {
  if (unit === 'pp') {
    const d = cur - prev;
    if (Math.abs(d) < 0.5) return { dir: 'flat', label: '0 pp' };
    return { dir: d > 0 ? 'up' : 'down', label: `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1).replace('.', ',')} pp` };
  }
  if (prev === 0) return cur === 0 ? { dir: 'flat', label: '0%' } : { dir: 'new', label: 'nuevo' };
  const d = ((cur - prev) / prev) * 100;
  if (Math.abs(d) < 0.5) return { dir: 'flat', label: '0%' };
  return { dir: d > 0 ? 'up' : 'down', label: `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0).replace('.', ',')}%` };
}

/** Semáforo del % de bots: texto + color (nunca solo color). */
export function botLevel(p: number): { tone: 'good' | 'warn' | 'bad'; label: string } {
  if (p >= 60) return { tone: 'bad', label: 'Alto' };
  if (p >= 30) return { tone: 'warn', label: 'Medio' };
  return { tone: 'good', label: 'Bajo' };
}

// ── País, fecha relativa y user-agent ───────────────────────────────────────

let regionNames: Intl.DisplayNames | null = null;
try { regionNames = new Intl.DisplayNames(['es'], { type: 'region' }); } catch { regionNames = null; }

/** Códigos especiales de Cloudflare: XX = desconocido, T1 = red Tor. */
export function countryName(code: string | null | undefined): string {
  if (!code) return 'Desconocido';
  if (code === 'XX') return 'Desconocido';
  if (code === 'T1') return 'Red Tor';
  try { return regionNames?.of(code) ?? code; } catch { return code; }
}

export function flagEmoji(code: string | null | undefined): string {
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return '🌐';
  return String.fromCodePoint(...[...code].map((c) => 127397 + c.charCodeAt(0)));
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: 'short' });
export function relTime(iso: string | null | undefined, now: Date = new Date()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '—';
  const s = Math.round((t - now.getTime()) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'ahora';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return rtf.format(Math.round(s / (30 * 86_400)), 'month');
}

/** "Chrome 141 · Windows", "Googlebot", "curl"… Legible, sin el ruido del UA completo. */
export function simplifyUA(ua: string | null | undefined): string {
  if (!ua) return 'Desconocido';
  const bot = ua.match(/(Googlebot|Google-InspectionTool|bingbot|GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Amazonbot|AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|Bytespider|YandexBot|DuckDuckBot|Applebot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|TelegramBot|UptimeRobot)/i);
  if (bot) return bot[1];
  const tool = ua.match(/^(curl|Wget|python-requests|python-urllib|Go-http-client|axios|node-fetch|okhttp|Scrapy|libwww-perl|Java)\b/i);
  if (tool) return tool[1];
  if (/HeadlessChrome/i.test(ua)) return 'Chrome headless';
  const generic = ua.match(/([A-Za-z0-9_-]*(?:bot|crawler|spider))\b/i);
  if (generic) return generic[1];

  const os = /Windows/i.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /CrOS/i.test(ua) ? 'ChromeOS'
    : /Linux|X11/i.test(ua) ? 'Linux' : '';
  const m = (re: RegExp) => ua.match(re)?.[1]?.split('.')[0];
  let browser = '';
  let v: string | undefined;
  if ((v = m(/Edg(?:e|A|iOS)?\/([\d.]+)/))) browser = `Edge ${v}`;
  else if ((v = m(/OPR\/([\d.]+)/))) browser = `Opera ${v}`;
  else if ((v = m(/(?:Firefox|FxiOS)\/([\d.]+)/))) browser = `Firefox ${v}`;
  else if ((v = m(/(?:Chrome|CriOS)\/([\d.]+)/))) browser = `Chrome ${v}`;
  else if ((v = m(/Version\/([\d.]+).*Safari/))) browser = `Safari ${v}`;
  else if (/Safari/i.test(ua)) browser = 'Safari';
  if (!browser && !os) return ua.slice(0, 32);
  return [browser, os].filter(Boolean).join(' · ');
}

// ── Insights automáticos ────────────────────────────────────────────────────

export interface Totals { total: number; humans: number; bots: number; posts: number; countries: number }
export interface RankRow { key: string; h: number; b: number }
export interface Insight { tone: 'good' | 'warn' | 'info'; text: string }

export interface InsightInput {
  cur: Totals;
  prev: Totals;
  posts: RankRow[];
  countries: RankRow[];
  series: SeriesPoint[];
  humansOnly: boolean;
  titleOf: (slug: string) => string;
}

/** Frases derivadas de los datos (sin IA ni coste): máximo 5, ordenadas por utilidad. */
export function buildInsights(i: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { cur, prev } = i;
  if (cur.total === 0) return out;

  // 1. Mezcla humanos/bots
  const botPct = Math.round(pct(cur.bots, cur.total));
  if (cur.bots === 0) out.push({ tone: 'good', text: 'No se han detectado bots en este periodo.' });
  else out.push({
    tone: botPct >= 60 ? 'warn' : botPct >= 30 ? 'info' : 'good',
    text: `El ${botPct}% del tráfico es bot (${fmtInt(cur.bots)} de ${fmtInt(cur.total)} visitas).`,
  });

  // 2. Mejor post por visitas humanas
  const bestPost = [...i.posts].filter((p) => p.h > 0).sort((a, b) => b.h - a.h)[0];
  if (bestPost) {
    const share = Math.round(pct(bestPost.h, cur.humans));
    out.push({ tone: 'good', text: `El post con mejor tracción humana es «${i.titleOf(bestPost.key)}», con ${fmtInt(bestPost.h)} visitas humanas (${share}% del total humano).` });
  }

  // 3. Evolución de las visitas humanas
  if (prev.humans > 0) {
    const d = ((cur.humans - prev.humans) / prev.humans) * 100;
    if (Math.abs(d) < 1) out.push({ tone: 'info', text: 'Las visitas humanas se mantienen estables frente al periodo anterior.' });
    else out.push({
      tone: d > 0 ? 'good' : 'warn',
      text: `Las visitas humanas ${d > 0 ? 'suben' : 'bajan'} un ${Math.abs(d).toFixed(0)}% frente al periodo anterior (${fmtInt(prev.humans)} → ${fmtInt(cur.humans)}).`,
    });
  } else if (cur.humans > 0) {
    out.push({ tone: 'good', text: `Hay ${fmtInt(cur.humans)} visitas humanas; el periodo anterior no registró ninguna.` });
  }

  // 4. País con más lectores humanos
  const topCountry = [...i.countries].filter((c) => c.h > 0).sort((a, b) => b.h - a.h)[0];
  if (topCountry) {
    out.push({ tone: 'info', text: `${flagEmoji(topCountry.key)} ${countryName(topCountry.key)} concentra el ${Math.round(pct(topCountry.h, cur.humans))}% de los lectores humanos.` });
  }

  // 5. País dominado por bots (solo cuando se ven los bots)
  if (!i.humansOnly) {
    const botty = i.countries
      .map((c) => ({ ...c, t: c.h + c.b }))
      .filter((c) => c.t >= 20 && c.b / c.t >= 0.9)
      .sort((a, b) => b.b - a.b)[0];
    if (botty) out.push({ tone: 'warn', text: `${flagEmoji(botty.key)} ${countryName(botty.key)}: el ${Math.round(pct(botty.b, botty.t))}% de sus visitas son bots (${fmtInt(botty.b)} de ${fmtInt(botty.t)}).` });
  }

  // 6. Pico de lectura humana
  if (i.series.length > 2) {
    const peak = i.series.reduce((m, p) => (p.h > m.h ? p : m), i.series[0]);
    if (peak.h >= 2) out.push({ tone: 'info', text: `El pico de lectura humana fue ${peak.long}, con ${fmtInt(peak.h)} visitas.` });
  }

  return out.slice(0, 5);
}
