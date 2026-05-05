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

  const { slug, autor, email, contenido } = body;

  if (!slug || !autor?.trim() || !contenido?.trim()) {
    return new Response('Faltan campos obligatorios', { status: 400 });
  }

  if (contenido.trim().length > 2000) {
    return new Response('Comentario demasiado largo', { status: 400 });
  }

  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? null;

  // Rate limiting: máximo 3 comentarios por IP en 10 minutos
  if (ip) {
    const recent = await db.prepare(
      `SELECT COUNT(*) as n FROM comments
       WHERE ip = ? AND created_at >= datetime('now', '-10 minutes')`
    ).bind(ip).first();

    if ((recent as any)?.n >= 3) {
      return new Response('Demasiados comentarios. Espera unos minutos.', { status: 429 });
    }
  }

  const created_at = new Date().toISOString();

  await db.prepare(
    `INSERT INTO comments (slug, autor, email, contenido, created_at, estado, ip)
     VALUES (?, ?, ?, ?, ?, 'pendiente', ?)`
  ).bind(slug, autor.trim(), email?.trim() ?? null, contenido.trim(), created_at, ip).run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};
