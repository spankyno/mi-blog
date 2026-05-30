import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return new Response(JSON.stringify({ error: 'DB no disponible' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  let body: any;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { id, accion } = body;
  if (!id || accion !== 'revisar') return new Response(JSON.stringify({ error: 'Parámetros inválidos' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  await db.prepare(`UPDATE submissions SET revisado = 1 WHERE id = ?`).bind(id).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return new Response(JSON.stringify({ error: 'DB no disponible' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  let body: any;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { id } = body;
  if (!id) return new Response(JSON.stringify({ error: 'ID requerido' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  await db.prepare(`DELETE FROM submissions WHERE id = ?`).bind(id).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
