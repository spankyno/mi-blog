import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchScannerPath } from '../src/lib/defense/scanner';
import { defend, resetDefenseMemory } from '../src/lib/defense/index';
import { FakeD1 } from './helpers/fake-d1';
import { makeCtx } from './helpers/ctx';

const level = (n: number) => ({ defense_level: String(n), defense_enabled: '1' });
beforeEach(() => resetDefenseMemory());

describe('matchScannerPath: rutas de escáner', () => {
  const scanners = [
    '/wp-login.php', '/wp-admin/', '/wp-admin/admin-ajax.php', '/wp-content/plugins/x/readme.txt', '/wp-includes/js/jquery.js', '/xmlrpc.php',
    '/.env', '/.env.production', '/.git/config', '/.git/HEAD', '/.svn/entries', '/.aws/credentials', '/.ssh/id_rsa', '/.DS_Store', '/.htaccess',
    '/phpmyadmin/', '/phpMyAdmin/index.php', '/pma/', '/adminer.php', '/administrator/index.php', '/cpanel',
    '/cgi-bin/luci', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', '/actuator/health', '/server-status', '/jenkins/login', '/boaform/admin/formLogin', '/HNAP1/',
    '/config.json', '/composer.json', '/backup.sql', '/dump.sql', '/db.sql', '/backup.zip', '/old/index.html',
    '/shell.php', '/wso.php', '/index.php', '/a/b/c.asp', '/login.aspx', '/test.jsp', '/script.cgi', '/archivo.bak', '/dump.old',
    '/blog/wp-login.php', '/blog/index.php', '/blog/x/shell.php',
  ];
  for (const p of scanners) {
    it(`detecta ${p}`, () => {
      assert.ok(matchScannerPath(p), `${p} debería detectarse`);
    });
  }
});

describe('matchScannerPath: rutas legítimas (sin falsos positivos)', () => {
  const legit = [
    '/', '/blog', '/blog/', '/blog/mi-articulo', '/blog/guia-wordpress', '/blog/php-vs-node', '/blog/backup-strategy',
    '/blog/como-usar-phpmyadmin', '/blog/que-es-un-env', '/blog/mi-config-json', '/blog/cgi-bin-historia',
    '/contacto', '/privacidad', '/rss.xml', '/sitemap.xml', '/robots.txt', '/llms.txt', '/favicon.ico', '/favicon.svg',
    '/images/AitorSanchez.webp', '/images/foto-portada.png', '/_astro/index.abc123.js', '/trap', '/404',
    '/8f2c6d4a9b1e7f3c0a5e8d2b6f9a1c3d.txt', '/panel', '/panel/defensa', '/panel/defensa/ayuda', '/api/comments', '/api/contacto',
    '/blog?page=2', '/blog/hola?utm_source=x',
  ];
  for (const p of legit) {
    it(`deja pasar ${p}`, () => assert.equal(matchScannerPath(p.split('?')[0]), null));
  }
});

describe('detector de escáneres en defend()', () => {
  async function scan(db: FakeD1, path: string, o: Parameters<typeof makeCtx>[1] = {}) {
    const c = makeCtx(db, { ip: '203.0.113.9', path, ...o });
    const out = await defend(c.ctx);
    await c.settle();
    return out;
  }

  it('nivel 0: marca como bot y banea 48 h, pero no corta la petición', async () => {
    const db = new FakeD1(level(0));
    const out = await scan(db, '/wp-login.php');
    assert.equal(out.response, undefined);
    assert.ok(out.info.flags[0].startsWith('scanner:'));
    const e = db.blockWhere('203.0.113.9')!;
    assert.equal(e.source, 'auto');
    assert.match(e.reason, /^Escáner: \/wp-login\.php/);
    const hours = (Date.parse(e.expires_at) - Date.now()) / 3_600_000;
    assert.ok(hours > 47.9 && hours <= 48, `duración ${hours} h`);
    assert.equal(db.eventsOf('auto_ban').length, 1);
  });

  it('nivel 2: esa misma petición y las siguientes reciben 403', async () => {
    const db = new FakeD1(level(2));
    assert.equal((await scan(db, '/.env')).response?.status, 403);
    assert.equal((await scan(db, '/blog/hola')).response?.status, 403);
  });

  it('en niveles 0–1, tras el baneo las visitas posteriores de esa IP quedan marcadas como bot', async () => {
    const db = new FakeD1(level(1));
    await scan(db, '/phpmyadmin/');
    const later = await scan(db, '/blog/un-articulo');
    assert.equal(later.response, undefined);
    assert.deepEqual(later.info.flags, ['blocklist:auto']);
  });

  it('varias peticiones de la misma IP escriben UN solo baneo', async () => {
    const db = new FakeD1(level(0));
    for (const p of ['/wp-login.php', '/xmlrpc.php', '/.env', '/wp-admin/', '/index.php']) await scan(db, p);
    assert.equal(db.blocks.filter((b) => b.value === '203.0.113.9').length, 1);
    assert.equal(db.eventsOf('auto_ban').length, 1);
  });

  it('la duración es configurable y se puede desactivar', async () => {
    const db = new FakeD1({ ...level(0), defense_scanner_hours: '72' });
    await scan(db, '/wp-login.php');
    const hours = (Date.parse(db.blockWhere('203.0.113.9')!.expires_at) - Date.now()) / 3_600_000;
    assert.ok(hours > 71.9 && hours <= 72);
    resetDefenseMemory();
    const off = new FakeD1({ ...level(2), defense_scanner_enabled: '0' });
    const out = await scan(off, '/wp-login.php');
    assert.equal(out.response, undefined);
    assert.deepEqual(out.info.flags, []);
    assert.equal(off.blocks.length, 0);
  });

  it('una ruta normal no se marca ni se banea', async () => {
    const db = new FakeD1(level(2));
    const out = await scan(db, '/blog/mi-articulo');
    assert.equal(out.response, undefined);
    assert.deepEqual(out.info.flags, []);
    assert.equal(db.blocks.length, 0);
  });

  it('exentos: lista blanca y Googlebot verificado por ASN; el falso Googlebot no', async () => {
    const wl = new FakeD1(level(2)).addAllowRow({ value: '203.0.113.9' });
    assert.equal((await scan(wl, '/wp-login.php')).response, undefined);
    assert.equal(wl.blocks.length, 0);
    resetDefenseMemory();
    const real = new FakeD1(level(2));
    assert.equal((await scan(real, '/wp-login.php', { ua: 'Googlebot/2.1', asn: 15169 })).response, undefined);
    assert.equal(real.blocks.length, 0);
    resetDefenseMemory();
    const fake = new FakeD1(level(2));
    assert.equal((await scan(fake, '/wp-login.php', { ua: 'Googlebot/2.1', asn: 16276 })).response?.status, 403);
  });

  it('IPv6: se banea el /64 completo', async () => {
    const db = new FakeD1(level(0));
    await scan(db, '/wp-login.php', { ip: '2001:db8:5:5:abcd::1' });
    assert.ok(db.blockWhere('2001:db8:5:5::/64'));
  });

  it('respeta el tope de entradas automáticas: marca, pero no escribe más', async () => {
    const db = new FakeD1(level(0));
    for (let i = 0; i < 500; i++) db.addBlockRow({ value: `10.0.${Math.floor(i / 250)}.${i % 250}`, source: 'auto' });
    const out = await scan(db, '/wp-login.php');
    assert.ok(out.info.flags[0].startsWith('scanner:'));
    assert.equal(db.blocks.length, 500);
  });

  it('no cuenta dos veces como «marcada» una IP ya listada', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const db = new FakeD1(level(0));
    for (const p of ['/wp-login.php', '/.env', '/xmlrpc.php']) await scan(db, p);
    t.mock.timers.tick(61_000);
    const c = makeCtx(db, { ip: '1.1.1.1', path: '/' });
    await defend(c.ctx); // dispara el volcado de contadores
    await c.settle();
    assert.equal(db.hourly[0].flagged, 3);
  });
});
