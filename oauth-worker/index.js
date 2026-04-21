export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/auth') {
      const params = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        redirect_uri: env.REDIRECT_URI,
        scope: 'repo,user',
      });
      return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      
      const data = await tokenRes.json();
      const token = data.access_token;
      
      const html = `<!DOCTYPE html>
<html>
<body>
<script>
  (function() {
    function receiveMessage(e) {
      console.log("receiveMessage %o", e);
    }
    window.addEventListener("message", receiveMessage, false);
    
    const message = JSON.stringify({
      token: "${token}",
      provider: "github"
    });
    
    if (window.opener) {
      window.opener.postMessage(
        "authorization:github:success:" + message,
        "*"
      );
    }
    
    setTimeout(function() { window.close(); }, 1000);
  })();
</script>
<p>Autenticación completada. Puedes cerrar esta ventana.</p>
</body>
</html>`;
      
      return new Response(html, { 
        headers: { 'Content-Type': 'text/html' } 
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
