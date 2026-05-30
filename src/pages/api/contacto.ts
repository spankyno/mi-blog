import type { APIRoute } from 'astro';

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime?.env?.DB;
  const secret = locals.runtime?.env?.TURNSTILE_SECRET;

  if (!db) return new Response(JSON.stringify({ error: 'DB no disponible' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  let body: any;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { nombre, email, asunto, comentario, token } = body;

  // Validar campos
  if (!nombre?.trim() || !email?.trim() || !asunto?.trim() || !comentario?.trim()) {
    return new Response(JSON.stringify({ error: 'Todos los campos son obligatorios.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (comentario.trim().length > 250) {
    return new Response(JSON.stringify({ error: 'El comentario no puede superar los 250 caracteres.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (!['Comentario', 'Opinión', 'Propuesta de colaboración'].includes(asunto)) {
    return new Response(JSON.stringify({ error: 'Asunto no válido.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Verificar Turnstile
  if (secret && token) {
    const ip = request.headers.get('cf-connecting-ip') ?? undefined;
    const formData = new FormData();
    formData.append('secret', secret);
    formData.append('response', token);
    if (ip) formData.append('remoteip', ip);

    const verification = await fetch(TURNSTILE_VERIFY, { method: 'POST', body: formData });
    const result: any = await verification.json();
    if (!result.success) {
      return new Response(JSON.stringify({ error: 'Verificación de seguridad fallida. Inténtalo de nuevo.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Rate limiting: máximo 3 mensajes por IP en 10 minutos
  const direccion_ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? null;
  if (direccion_ip && db) {
    const recent = await db.prepare(
      `SELECT COUNT(*) as n FROM submissions WHERE direccion_ip = ? AND fecha_hora >= datetime('now', '-10 minutes')`
    ).bind(direccion_ip).first().catch(() => null);
    if ((recent as any)?.n >= 3) {
      return new Response(JSON.stringify({ error: 'Demasiados mensajes. Espera unos minutos.' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Guardar en D1
  await db.prepare(
    `INSERT INTO submissions (fecha_hora, direccion_ip, nombre, email, asunto, comentario, revisado)
     VALUES (datetime('now'), ?, ?, ?, ?, ?, 0)`
  ).bind(direccion_ip, nombre.trim(), email.trim().toLowerCase(), asunto, comentario.trim()).run();

  return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
};
