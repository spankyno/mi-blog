// src/lib/defense/cache.ts
// ─────────────────────────────────────────────────────────────────────────────
// Caché del estado en memoria del isolate. La comprobación por petición NO
// consulta D1: solo se refresca cuando han pasado más de CACHE_TTL_MS.
// Los cambios del panel llegan al resto de isolates en ≤ 60 s.
// ─────────────────────────────────────────────────────────────────────────────
import { CACHE_TTL_MS } from './config';
import { loadState, type DefenseState } from './store';

let cached: DefenseState | null = null;
let loading: Promise<DefenseState | null> | null = null;

/** Devuelve el estado cacheado; si falla D1, la última copia buena (o null). */
export async function getState(db: any): Promise<DefenseState | null> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached;

  // Una sola carga simultánea por isolate.
  if (!loading) {
    loading = loadState(db)
      .then((s) => {
        cached = s;
        return s;
      })
      .catch((e) => {
        console.error('defense: error cargando estado, uso la última copia:', e);
        // Reintento en ~10 s (no en cada petición) para no agravar una caída de D1.
        if (cached) cached = { ...cached, loadedAt: Date.now() - CACHE_TTL_MS + 10_000 };
        return cached;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Fuerza recarga en la próxima petición (la usa la API tras escribir). */
export function invalidateState(): void {
  cached = null;
}
