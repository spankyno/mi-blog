// src/pages/trap.ts
// ─────────────────────────────────────────────────────────────────────────────
// Endpoint honeypot. Solo lo siguen bots/crawlers que ignoran que el enlace
// en el Footer está oculto (aria-hidden, opacity:0, pointer-events:none).
// Registra la IP en `bot_ips` y devuelve 404 para no delatar su función.
// ─────────────────────────────────────────────────────────────────────────────
import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const db = (locals as any).runtime?.env?.DB;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';

  if (db) {
    try {
      await db
        .prepare(
          `INSERT INTO bot_ips (ip, detected_at, method)
           VALUES (?, datetime('now'), 'honeypot')
           ON CONFLICT(ip) DO UPDATE SET detected_at = excluded.detected_at`
        )
        .bind(ip)
        .run();
    } catch {
      // No romper la respuesta si la tabla no existe o D1 falla
    }
  }

  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });
};

// Cualquier otro método (POST, HEAD...) se trata igual: registrar y 404.
export const ALL: APIRoute = GET;
