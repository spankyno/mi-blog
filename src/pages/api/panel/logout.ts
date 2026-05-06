import type { APIRoute } from 'astro';

export const POST: APIRoute = async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `panel_token=; HttpOnly; Secure; SameSite=Strict; Path=/panel; Max-Age=0`,
    },
  });
};
