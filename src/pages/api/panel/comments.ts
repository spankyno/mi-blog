import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return new Response('DB no disponible', { status: 500 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  const { id, accion } = body;

  if (!id || !['aprobar', 'rechazar'].includes(accion)) {
    return new Response('Parámetros inválidos', { status: 400 });
  }

  const estado = accion === 'aprobar' ? 'aprobado' : 'rechazado';

  await db.prepare(
    `UPDATE comments SET estado = ? WHERE id = ?`
  ).bind(estado, id).run();

  return new Response(JSON.stringify({ ok: true, estado }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return new Response('DB no disponible', { status: 500 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  const { id } = body;
  if (!id) return new Response('ID requerido', { status: 400 });

  await db.prepare(`DELETE FROM comments WHERE id = ?`).bind(id).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
