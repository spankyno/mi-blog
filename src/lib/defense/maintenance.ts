// src/lib/defense/maintenance.ts
// ─────────────────────────────────────────────────────────────────────────────
// Respuesta 503 del modo mantenimiento y 403 del bloqueo. Páginas HTML
// autocontenidas (sin consultas a D1 ni recursos externos) con la paleta del
// blog en claro/oscuro.
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

/** Segundos para `Retry-After`: hasta la ETA si existe, si no 10 min. */
function retryAfterSeconds(eta: string | null): number {
  if (eta) {
    const t = Date.parse(eta);
    if (Number.isFinite(t)) {
      const secs = Math.round((t - Date.now()) / 1000);
      return Math.min(Math.max(secs, 60), 86_400);
    }
  }
  return 600;
}

export function maintenanceResponse(message: string, eta: string | null): Response {
  let etaHtml = '';
  if (eta) {
    const t = Date.parse(eta);
    if (Number.isFinite(t) && t > Date.now()) {
      const txt = new Date(t).toLocaleString('es-ES', {
        timeZone: 'Europe/Madrid',
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      etaHtml = `<p class="eta">Vuelta estimada: ${esc(txt)} (hora de Madrid)</p>`;
    }
  }

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Mantenimiento — Aitor Sánchez</title>
<style>
  :root { --bg:#fafaf8; --text:#1a1a18; --muted:#6b6b67; --border:#e5e5e0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#121212; --text:#e5e5e5; --muted:#a1a1aa; --border:#27272a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:2rem; background:var(--bg); color:var(--text);
         font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif; }
  main { max-width:32rem; text-align:center; }
  .mark { width:3.2rem; height:3.2rem; margin:0 auto 1.5rem; color:var(--muted); }
  h1 { font-family:'DM Serif Display',Georgia,'Times New Roman',serif; font-weight:400;
       font-size:2.1rem; letter-spacing:-0.02em; margin:0 0 1rem; }
  p { color:var(--muted); line-height:1.65; margin:0 0 .8rem; }
  .eta { color:var(--text); font-size:.9rem; padding-top:1rem; margin-top:1.2rem; border-top:1px solid var(--border); }
</style>
</head>
<body>
<main>
  <svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
  <h1>Volvemos enseguida</h1>
  <p>${esc(message)}</p>
  ${etaHtml}
</main>
</body>
</html>`;

  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(retryAfterSeconds(eta)),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

export function forbiddenResponse(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

export function tooManyRequestsResponse(retryAfterSeconds: number): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': String(Math.max(1, Math.round(retryAfterSeconds))),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
