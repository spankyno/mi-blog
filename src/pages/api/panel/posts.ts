import type { APIRoute } from 'astro';

export const DELETE: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: 'DB no disponible' }), { status: 500 });
  }

  let body: { slug?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 });
  }

  const { slug } = body;
  if (!slug) {
    return new Response(JSON.stringify({ error: 'Falta el slug' }), { status: 400 });
  }

  await db.prepare(`DELETE FROM posts WHERE slug = ?`).bind(slug).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
