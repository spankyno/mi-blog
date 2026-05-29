import type { APIRoute } from 'astro';

const JWT_COOKIE = 'panel_token';
const MAX_ATTEMPTS = 5;
const BLOCK_MINUTES = 15;

async function createJWT(secret: string, expiresInHours = 8): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({ iat: now, exp: now + expiresInHours * 3600, role: 'admin' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${data}.${sigB64}`;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime?.env?.DB;
  const env = locals.runtime?.env;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  const { user, pass } = body;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';

  // Rate limiting: máximo 5 intentos por IP en 15 minutos
  if (db) {
    const recent = await db.prepare(
      `SELECT COUNT(*) as n FROM login_attempts
       WHERE ip = ? AND created_at >= datetime('now', '-${BLOCK_MINUTES} minutes') AND success = 0`
    ).bind(ip).first().catch(() => null);

    if ((recent as any)?.n >= MAX_ATTEMPTS) {
      return new Response(JSON.stringify({ error: `Demasiados intentos. Espera ${BLOCK_MINUTES} minutos.` }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const expectedUser = env?.ADMIN_USER;
  const expectedPass = env?.ADMIN_PASS;
  const secret = env?.JWT_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: 'Error de configuración del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const valid = user === expectedUser && pass === expectedPass;

  // Registrar intento
  if (db) {
    await db.prepare(
      `INSERT INTO login_attempts (ip, created_at, success) VALUES (?, datetime('now'), ?)`
    ).bind(ip, valid ? 1 : 0).run().catch(() => null);
  }

  if (!valid) {
    return new Response(JSON.stringify({ error: 'Credenciales incorrectas' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = await createJWT(secret);
  const maxAge = 8 * 3600;

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${JWT_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/panel; Max-Age=${maxAge}`,
    },
  });
};
