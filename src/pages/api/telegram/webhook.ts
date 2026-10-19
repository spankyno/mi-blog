import type { APIRoute } from 'astro';
import { handleUpdate } from '../../../lib/defense/telegram-bot';
import { timingSafeEqual } from '../../../lib/defense/telegram-api';

// POST /api/telegram/webhook
// Recibe las actualizaciones de Telegram (pulsaciones de botones y /estado).
// Ruta pública (sin JWT): se autentica con la cabecera
// X-Telegram-Bot-Api-Secret-Token, que debe coincidir con TELEGRAM_WEBHOOK_SECRET.
// El módulo de defensa nunca la bloquea (ver isDefenseExempt).

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals.runtime?.env ?? {}) as any;
  const db = env.DB;
  const secret: string | undefined = env.TELEGRAM_WEBHOOK_SECRET;

  // Sin secret configurado la ruta no existe: nunca se acepta tráfico sin autenticar.
  if (!secret || !env.TELEGRAM_CHAT_ID || !env.TELEGRAM_BOT_TOKEN || !db) {
    return new Response('Not found', { status: 404 });
  }

  const got = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqual(got, secret)) {
    return new Response('Forbidden', { status: 403 });
  }

  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > 100_000) return new Response('Payload too large', { status: 413 });

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  try {
    await handleUpdate(update, env, db);
  } catch (e) {
    // Siempre 200: si no, Telegram reintentaría la misma actualización sin parar.
    console.error('telegram webhook error:', e);
  }
  return new Response('ok', { status: 200 });
};

export const GET: APIRoute = async () => new Response('Method not allowed', { status: 405 });
