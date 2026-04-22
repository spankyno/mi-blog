import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);

  if (!url.pathname.startsWith('/admin')) {
    return next();
  }

  const authHeader = context.request.headers.get('Authorization');

  if (authHeader) {
    const base64 = authHeader.replace('Basic ', '');
    const decoded = atob(base64);
    const [user, pass] = decoded.split(':');

    const expectedUser = context.locals.runtime?.env?.ADMIN_USER;
    const expectedPass = context.locals.runtime?.env?.ADMIN_PASS;

    if (user === expectedUser && pass === expectedPass) {
      return next();
    }
  }

  return new Response('Acceso no autorizado', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Blog Admin"',
    },
  });
});
