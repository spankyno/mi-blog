import { defineMiddleware } from 'astro:middleware';

const JWT_COOKIE = 'panel_token';

const CSP_PUBLIC = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com https://uicdn.toast.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://uicdn.toast.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https: blob:",
  "connect-src 'self' https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join('; ');

const CSP_PANEL = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://uicdn.toast.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://uicdn.toast.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https: blob:",
  "connect-src 'self' https://www.google-analytics.com https://analytics.google.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function addSecurityHeaders(response: Response, isPanel: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()');
  headers.set('Content-Security-Policy', isPanel ? CSP_PANEL : CSP_PUBLIC);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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
  const isPanel = url.pathname.startsWith('/panel');

  // Excluir rutas XML — no necesitan cabeceras de seguridad web
  if (url.pathname === '/sitemap.xml' || url.pathname === '/rss.xml') {
    return next();
  }

  // Auth del panel
  if (isPanel) {
    if (url.pathname !== '/panel/login' && !url.pathname.startsWith('/api/panel/auth')) {
      const cookie = context.request.headers.get('cookie') ?? '';
      const token = cookie.split(';').find(c => c.trim().startsWith(`${JWT_COOKIE}=`))?.split('=')[1]?.trim();
      const secret = context.locals.runtime?.env?.JWT_SECRET ?? 'fallback-secret-change-me';

      if (!token || !await verifyJWT(token, secret)) {
        return Response.redirect(new URL('/panel/login', context.request.url));
      }
    }
  }

  // Añadir cabeceras de seguridad a la respuesta
  const response = await next();
  return addSecurityHeaders(response, isPanel);
});
