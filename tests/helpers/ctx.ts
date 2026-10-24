// tests/helpers/ctx.ts — contexto de petición equivalente al de Astro/Cloudflare.
import type { FakeD1 } from './fake-d1';

export const TG_ENV = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '111', TELEGRAM_WEBHOOK_SECRET: 'secret-secret-1234' };

export interface CtxOptions {
  ip?: string;
  path?: string;
  ua?: string | null;
  asn?: number;
  org?: string;
  country?: string;
  env?: Record<string, any>;
}

/**
 * Devuelve { ctx, background }: `ctx` es lo que recibe defend(); `background`
 * recoge las promesas de waitUntil y `await settle()` espera a que terminen.
 */
export function makeCtx(db: FakeD1 | any, o: CtxOptions = {}) {
  const pending: Promise<unknown>[] = [];
  const headers: Record<string, string> = { 'cf-connecting-ip': o.ip ?? '7.7.7.7' };
  if (o.ua !== null) headers['user-agent'] = o.ua ?? 'Mozilla/5.0 (Macintosh) Chrome/130';
  const ctx = {
    request: new Request('https://blog.test' + (o.path ?? '/blog/a'), { headers }),
    locals: {
      runtime: {
        env: { DB: db, ...(o.env ?? {}) },
        cf: { asn: o.asn, asOrganization: o.org, country: o.country },
        ctx: { waitUntil(p: Promise<unknown>) { pending.push(p.catch(() => undefined)); } },
      },
    },
  };
  return { ctx, settle: async () => { await Promise.all(pending.splice(0)); await new Promise((r) => setTimeout(r, 25)); } };
}
