// src/lib/defense/telegram-api.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cliente mínimo de la Bot API de Telegram para la defensa (alertas con
// botones y webhook). No toca src/lib/telegram.ts. Todos los métodos son
// tolerantes a fallos: nunca lanzan, devuelven { ok, description }.
// ─────────────────────────────────────────────────────────────────────────────

export interface TgEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export type Keyboard = Array<Array<{ text: string; callback_data: string }>>;

export interface TgResult {
  ok: boolean;
  description?: string;
  result?: any;
}

/** Escapa texto para parse_mode HTML de Telegram (siempre, también con datos propios). */
export function esc(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Comparación en tiempo constante de dos cadenas. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function call(env: TgEnv, method: string, body: Record<string, unknown>): Promise<TgResult> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: 'Falta TELEGRAM_BOT_TOKEN' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok || !json?.ok) {
      console.error(`[Telegram] ${method} error:`, json?.description ?? res.status);
      return { ok: false, description: json?.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, result: json.result };
  } catch (e: any) {
    console.error(`[Telegram] ${method} fallo de red:`, e?.message ?? e);
    return { ok: false, description: 'Fallo de red al contactar con Telegram' };
  }
}

export function sendMessage(env: TgEnv, text: string, keyboard?: Keyboard): Promise<TgResult> {
  if (!env.TELEGRAM_CHAT_ID) return Promise.resolve({ ok: false, description: 'Falta TELEGRAM_CHAT_ID' });
  return call(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export function setKeyboard(env: TgEnv, messageId: number, keyboard: Keyboard | null): Promise<TgResult> {
  return call(env, 'editMessageReplyMarkup', {
    chat_id: env.TELEGRAM_CHAT_ID,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard ?? [] },
  });
}

export function answerCallback(env: TgEnv, callbackId: string, text: string, alert = false): Promise<TgResult> {
  return call(env, 'answerCallbackQuery', { callback_query_id: callbackId, text: text.slice(0, 200), show_alert: alert });
}

export function setWebhook(env: TgEnv, url: string): Promise<TgResult> {
  return call(env, 'setWebhook', {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['callback_query', 'message'],
    drop_pending_updates: true,
    max_connections: 5,
  });
}

export function getWebhookInfo(env: TgEnv): Promise<TgResult> {
  return call(env, 'getWebhookInfo', {});
}
