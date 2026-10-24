// src/lib/defense/scanner.ts
// ─────────────────────────────────────────────────────────────────────────────
// Detector de rutas de escáner. Este blog no es WordPress, ni PHP, ni expone
// ficheros de configuración: quien pide /wp-login.php, /.env o /phpmyadmin está
// buscando vulnerabilidades. Es una señal casi sin falsos positivos.
//
// Solo mira la RUTA (sin consultas a D1/KV): coste de cuota cero.
// Para no confundir con artículos, los prefijos y fragmentos NO se aplican a
// rutas que cuelgan de /blog/ (un título como «guia-wordpress» no es un escáner);
// solo las extensiones peligrosas (.php, .env…) se comprueban en todas partes.
// ─────────────────────────────────────────────────────────────────────────────

/** Rutas (desde la raíz) que ningún lector legítimo pide. */
const PREFIXES = [
  // WordPress y CMS
  '/wp-admin', '/wp-content', '/wp-includes', '/wp-json', '/wp-login', '/wp/', '/wordpress', '/xmlrpc',
  '/administrator', '/joomla', '/drupal', '/typo3', '/magento', '/sitecore', '/umbraco',
  // Paneles de bases de datos y administración
  '/phpmyadmin', '/pma', '/myadmin', '/mysql', '/adminer', '/webmail', '/cpanel', '/plesk',
  // Ficheros sensibles y repositorios
  '/.env', '/.git', '/.svn', '/.hg', '/.aws', '/.ssh', '/.docker', '/.vscode', '/.idea',
  '/.ds_store', '/.htaccess', '/.htpasswd', '/.npmrc', '/.bash_history',
  '/config.json', '/config.yml', '/config.yaml', '/credentials', '/secrets', '/id_rsa',
  '/composer.json', '/composer.lock', '/package.json', '/package-lock.json', '/docker-compose',
  // Infraestructura y frameworks
  '/cgi-bin', '/vendor/', '/actuator', '/server-status', '/server-info', '/jenkins', '/solr/',
  '/manager/html', '/jmx-console', '/console', '/boaform', '/hnap1', '/owa/', '/ecp/', '/remote/login',
  '/_ignition', '/telescope', '/debug/', '/phpinfo', '/shell', '/webshell', '/cmd', '/eval',
  // Volcados y copias de seguridad en la raíz
  '/backup', '/db.', '/dump.', '/database.', '/sql.', '/old/', '/bak/',
  // Lectura de ficheros del sistema
  '/etc/passwd', '/proc/self', '/bin/sh', '/windows/win.ini',
];

/** Fragmentos peligrosos en cualquier parte de la ruta. */
const CONTAINS = [
  '/../', '/..;/', '/etc/passwd', '/proc/self/', 'eval-stdin', '/.git/', '/.env', 'phpmyadmin', 'wp-includes', 'wp-content/plugins',
];

/** Extensiones que este sitio nunca sirve. Se comprueban en TODAS las rutas. */
const SUFFIXES = ['.php', '.phtml', '.php3', '.php4', '.php5', '.asp', '.aspx', '.jsp', '.jspx', '.cgi', '.env', '.sql', '.bak', '.old', '.orig', '.swp'];

/** Resumen legible para el panel y la ayuda (no se usa para detectar). */
export const SCANNER_RULE_SUMMARY: { group: string; examples: string }[] = [
  { group: 'WordPress y otros CMS', examples: '/wp-login.php, /wp-admin, /wp-content, /xmlrpc.php, /administrator, /joomla' },
  { group: 'Paneles de administración y bases de datos', examples: '/phpmyadmin, /pma, /adminer, /cpanel, /webmail' },
  { group: 'Ficheros sensibles y repositorios', examples: '/.env, /.git, /.svn, /.aws, /.ssh, /.htaccess, /config.json, /composer.json, /id_rsa' },
  { group: 'Infraestructura y frameworks', examples: '/cgi-bin, /vendor/, /actuator, /server-status, /jenkins, /boaform, /_ignition, /phpinfo' },
  { group: 'Volcados y copias de seguridad', examples: '/backup, /dump.sql, /db.sql, /old/, /bak/' },
  { group: 'Lectura de ficheros del sistema', examples: '/etc/passwd, /proc/self, ../../ (recorrido de directorios)' },
  { group: 'Extensiones que este sitio nunca sirve (en cualquier ruta)', examples: '.php, .asp, .aspx, .jsp, .cgi, .env, .sql, .bak, .old, .swp' },
];

function normalize(pathname: string): string {
  let p = pathname;
  try { p = decodeURIComponent(p); } catch { /* secuencia % inválida: se usa tal cual */ }
  p = p.toLowerCase().replace(/\/{2,}/g, '/');
  return p.startsWith('/') ? p : '/' + p;
}

/**
 * Devuelve la regla que coincide (para el motivo del baneo) o null si la ruta es normal.
 * Ejemplos: '/wp-login.php' → 'prefijo /wp-login'; '/x/shell.php' → 'extensión .php'.
 */
export function matchScannerPath(pathname: string): string | null {
  const p = normalize(pathname);
  const underBlog = p === '/blog' || p.startsWith('/blog/');

  for (const s of SUFFIXES) {
    if (p.endsWith(s)) return `extensión ${s}`;
  }
  if (underBlog) return null;

  for (const c of CONTAINS) {
    if (p.includes(c)) return `fragmento ${c}`;
  }
  for (const pre of PREFIXES) {
    if (p === pre || p.startsWith(pre)) return `ruta ${pre.replace(/\/$/, '')}`;
  }
  return null;
}
