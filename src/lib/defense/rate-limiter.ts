// src/lib/defense/rate-limiter.ts
// ─────────────────────────────────────────────────────────────────────────────
// Limitador de frecuencia en memoria del isolate (ventana deslizante
// aproximada con dos contadores). No usa KV ni D1: coste de cuota cero.
// Limitación: cada isolate cuenta por separado, así que es aproximado; para un
// blog pequeño basta y el atacante concentrado en una IP sí se detecta.
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket { start: number; curr: number; prev: number; last: number }

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 5000;
const STALE_MS = 2 * 3600_000;

/**
 * Registra una visita y devuelve la estimación de visitas en la última ventana.
 * est = previa × (1 − transcurrido/ventana) + actual
 */
export function hit(key: string, windowMs: number, now = Date.now()): number {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_KEYS) prune(now);
    b = { start: now, curr: 0, prev: 0, last: now };
    buckets.set(key, b);
  }

  const elapsed = now - b.start;
  if (elapsed >= 2 * windowMs) {
    b.prev = 0; b.curr = 0; b.start = now;
  } else if (elapsed >= windowMs) {
    b.prev = b.curr; b.curr = 0; b.start += windowMs;
  }

  b.curr++;
  b.last = now;
  const frac = Math.min(1, (now - b.start) / windowMs);
  return b.prev * (1 - frac) + b.curr;
}

function prune(now: number): void {
  for (const [k, b] of buckets) {
    if (now - b.last > STALE_MS) buckets.delete(k);
  }
  // Si sigue lleno (ataque con millones de claves distintas), se vacía: es solo una caché.
  if (buckets.size >= MAX_KEYS) buckets.clear();
}

export function resetRateLimiter(): void {
  buckets.clear();
}

/** Coincidencia de ruta: '*' (todo), '/blog/*' (prefijo) o ruta exacta. */
export function matchPath(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(base + '/');
  }
  return path === pattern;
}
