// src/lib/defense/counters.ts
// ─────────────────────────────────────────────────────────────────────────────
// Contadores en memoria, volcados a D1 como mucho una vez por minuto y isolate.
// Así un ataque no genera una escritura en D1 por cada petición bloqueada.
// ─────────────────────────────────────────────────────────────────────────────
import { bumpHourly } from './store';

type Kind = 'flagged' | 'limited' | 'blocked' | 'maint';

const FLUSH_EVERY_MS = 60_000;
let counts: Record<Kind, number> = { flagged: 0, limited: 0, blocked: 0, maint: 0 };
let lastFlush = Date.now();

export function count(kind: Kind): void {
  counts[kind]++;
}

/** Vuelca los contadores a D1 si toca. Devuelve la promesa para `waitUntil`. */
export function maybeFlush(db: any): Promise<void> | null {
  const total = counts.flagged + counts.limited + counts.blocked + counts.maint;
  if (total === 0 || Date.now() - lastFlush < FLUSH_EVERY_MS) return null;

  const snapshot = counts;
  counts = { flagged: 0, limited: 0, blocked: 0, maint: 0 };
  lastFlush = Date.now();
  const hour = new Date().toISOString().slice(0, 13); // 2026-10-18T14

  return bumpHourly(db, hour, snapshot).catch((e) => {
    // Si falla, se pierden estos contadores; no es crítico.
    console.error('defense: error volcando contadores:', e);
  });
}

/** Solo para pruebas. */
export function resetCounters(): void {
  counts = { flagged: 0, limited: 0, blocked: 0, maint: 0 };
  lastFlush = Date.now();
}
