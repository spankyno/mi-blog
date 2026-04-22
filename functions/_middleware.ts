const PROTECTED_PATH = '/admin';

export async function onRequest(context: any) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  if (!url.pathname.startsWith(PROTECTED_PATH)) {
    return next();
  }

  const authHeader = request.headers.get('Authorization');

  if (authHeader) {
    const base64 = authHeader.replace('Basic ', '');
    const decoded = atob(base64);
    const [user, pass] = decoded.split(':');

    if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
      return next();
    }
  }

  return new Response('Acceso no autorizado', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Blog Admin"',
    },
  });
}