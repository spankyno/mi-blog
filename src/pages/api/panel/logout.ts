import type { APIRoute } from 'astro';

export const POST: APIRoute = async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // El Path debe coincidir EXACTAMENTE con el usado al fijar la cookie en
      // auth.ts (Path=/); si no coincide, el navegador no la borra y la sesión
      // sigue siendo válida pese a haber "cerrado sesión".
      'Set-Cookie': `panel_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    },
  });
};
