import { defineMiddleware } from 'astro:middleware';

const JWT_COOKIE = 'panel_token';

async function verifyJWT(token: string, secret: string): Promise<boolean> {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return false;

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false;

    const data = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signature = Uint8Array.from(
      atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );

    return await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(data));
  } catch {
    return false;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);

  if (!url.pathname.startsWith('/panel')) return next();
  if (url.pathname === '/panel/login') return next();
  if (url.pathname.startsWith('/api/panel/auth')) return next();

  const cookie = context.request.headers.get('cookie') ?? '';
  const token = cookie.split(';').find(c => c.trim().startsWith(`${JWT_COOKIE}=`))?.split('=')[1]?.trim();
  const secret = context.locals.runtime?.env?.JWT_SECRET ?? 'fallback-secret-change-me';

  if (token && await verifyJWT(token, secret)) {
    return next();
  }

  return Response.redirect(new URL('/panel/login', context.request.url));
});
