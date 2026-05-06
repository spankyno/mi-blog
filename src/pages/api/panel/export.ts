import type { APIRoute } from 'astro';

const ALLOWED_TABLES: Record<string, string> = {
  posts: `SELECT * FROM posts ORDER BY pub_date DESC`,
  comments: `SELECT * FROM comments ORDER BY created_at DESC`,
  page_views: `SELECT * FROM page_views ORDER BY viewed_at DESC`,
};

export const GET: APIRoute = async ({ url, locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return new Response('DB no disponible', { status: 500 });

  const tabla = url.searchParams.get('tabla') ?? '';

  if (!ALLOWED_TABLES[tabla]) {
    return new Response('Tabla no válida', { status: 400 });
  }

  const result = await db.prepare(ALLOWED_TABLES[tabla]).all();
  const data = result.results ?? [];

  const fecha = new Date().toISOString().split('T')[0];
  const filename = `${tabla}-${fecha}.json`;

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
};
