// tests/helpers/telegram.ts — sustituye fetch por un Telegram simulado.
export interface TgCall { method: string; body: any }

export function mockTelegram() {
  const calls: TgCall[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    const method = String(url).split('/').pop()!;
    calls.push({ method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  return {
    calls,
    /** Llamadas a un método de la Bot API (por defecto sendMessage). */
    sent: (method = 'sendMessage') => calls.filter((c) => c.method === method),
    clear: () => { calls.length = 0; },
    restore: () => { (globalThis as any).fetch = original; },
  };
}
