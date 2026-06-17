import type { APIRoute } from 'astro';

// GET  /api/panel/telegram  → devuelve { enabled: boolean }
// POST /api/panel/telegram  → cambia el estado y devuelve { enabled: boolean }
// Ambas rutas están protegidas por el middleware JWT del panel.

export const GET: APIRoute = async ({ locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return json({ error: 'DB no disponible' }, 500);

  const enabled = await getEnabled(db);
  return json({ enabled });
};

export const POST: APIRoute = async ({ locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return json({ error: 'DB no disponible' }, 500);

  const current = await getEnabled(db);
  const next = !current;

  await db
    .prepare(`INSERT INTO settings (key, value) VALUES ('telegram_enabled', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(next ? '1' : '0')
    .run();

  return json({ enabled: next });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getEnabled(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'telegram_enabled' LIMIT 1`)
      .first<{ value: string }>();
    if (!row) return true; // activado por defecto si la fila no existe
    return row.value !== '0';
  } catch {
    return true;
  }
}

function json(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
