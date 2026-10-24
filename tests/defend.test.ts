import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { defend, resetDefenseMemory } from '../src/lib/defense/index';
import { invalidateState } from '../src/lib/defense/cache';
import { FakeD1 } from './helpers/fake-d1';
import { makeCtx } from './helpers/ctx';

const level = (n: number) => ({ defense_level: String(n), defense_enabled: '1' });

beforeEach(() => resetDefenseMemory());

describe('niveles y listas', () => {
  const run = async (db: FakeD1, ip: string, o: Parameters<typeof makeCtx>[1] = {}) => {
    const { ctx } = makeCtx(db, { ip, ...o });
    return defend(ctx);
  };

  it('nivel 0: una IP listada solo se marca', async () => {
    const db = new FakeD1(level(0)).addBlockRow({ value: '45.138.12.27' });
    const out = await run(db, '45.138.12.27');
    assert.equal(out.response, undefined);
    assert.deepEqual(out.info.flags, ['blocklist:manual']);
  });

  it('nivel 1: una IP listada solo se marca', async () => {
    const out = await run(new FakeD1(level(1)).addBlockRow({ value: '45.138.12.27' }), '45.138.12.27');
    assert.equal(out.response, undefined);
    assert.deepEqual(out.info.flags, ['blocklist:manual']);
  });

  it('nivel 2: una IP listada recibe 403 y una no listada pasa', async () => {
    const db = new FakeD1(level(2)).addBlockRow({ value: '45.138.12.27' });
    assert.equal((await run(db, '45.138.12.27')).response?.status, 403);
    resetDefenseMemory();
    assert.equal((await run(db, '8.8.8.8')).response, undefined);
  });

  it('nivel 2: las IPs del honeypot solo se marcan, nunca se bloquean', async () => {
    const out = await run(new FakeD1(level(2)).addHoneypotIp('6.6.6.6'), '6.6.6.6');
    assert.equal(out.response, undefined);
    assert.deepEqual(out.info.flags, ['blocklist:honeypot']);
  });

  it('la lista blanca gana a la de bloqueo', async () => {
    const db = new FakeD1(level(2)).addBlockRow({ value: '45.138.12.27' }).addAllowRow({ value: '45.138.12.27' });
    const out = await run(db, '45.138.12.27');
    assert.equal(out.response, undefined);
    assert.deepEqual(out.info.flags, []);
  });

  it('bloqueo por ASN, por país, por rango IPv4 y por /64 IPv6 (nivel 2)', async () => {
    const asn = new FakeD1(level(2)).addBlockRow({ kind: 'asn', value: '16276' });
    assert.equal((await run(asn, '9.9.9.9', { asn: 16276 })).response?.status, 403);
    resetDefenseMemory();
    const country = new FakeD1(level(2)).addBlockRow({ kind: 'country', value: 'XX' });
    assert.equal((await run(country, '9.9.9.9', { country: 'XX' })).response?.status, 403);
    resetDefenseMemory();
    const cidr = new FakeD1(level(2)).addBlockRow({ kind: 'cidr', value: '45.138.12.0/24' });
    assert.equal((await run(cidr, '45.138.12.200')).response?.status, 403);
    resetDefenseMemory();
    const v6 = new FakeD1(level(2)).addBlockRow({ kind: 'cidr', value: '2001:41d0:701:1100::/64' });
    assert.equal((await run(v6, '2001:41d0:701:1100::52d6')).response?.status, 403);
  });

  it('las entradas caducadas no bloquean', async () => {
    const db = new FakeD1(level(2)).addBlockRow({ value: '1.1.1.1', expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await run(db, '1.1.1.1')).response, undefined);
  });

  it('interruptor maestro apagado: no hace nada ni en mantenimiento', async () => {
    const db = new FakeD1({ defense_level: '3', defense_enabled: '0' }).addBlockRow({ value: '1.1.1.1' });
    const out = await run(db, '1.1.1.1');
    assert.equal(out.response, undefined);
    assert.deepEqual(out.info.flags, []);
  });

  it('sin ajustes ni listas: la petición pasa', async () => {
    assert.equal((await run(new FakeD1(), '1.2.3.4')).response, undefined);
  });
});

describe('mantenimiento (nivel 3)', () => {
  it('503 con Retry-After de 10 min por defecto y X-Robots-Tag noindex', async () => {
    const { ctx } = makeCtx(new FakeD1(level(3)), { ip: '8.8.8.8' });
    const res = (await defend(ctx)).response!;
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Retry-After'), '600');
    assert.equal(res.headers.get('X-Robots-Tag'), 'noindex');
  });

  it('la hora estimada fija Retry-After (con tope de 24 h)', async () => {
    const eta = new Date(Date.now() + 2 * 3600_000).toISOString();
    const res = (await defend(makeCtx(new FakeD1({ ...level(3), maintenance_eta: eta }), { ip: '8.8.8.8' }).ctx)).response!;
    const secs = Number(res.headers.get('Retry-After'));
    assert.ok(secs > 7000 && secs <= 7200, `Retry-After fuera de rango: ${secs}`);
    resetDefenseMemory();
    const far = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const res2 = (await defend(makeCtx(new FakeD1({ ...level(3), maintenance_eta: far }), { ip: '8.8.8.8' }).ctx)).response!;
    assert.equal(res2.headers.get('Retry-After'), '86400');
  });

  it('el mensaje se escapa (no admite HTML)', async () => {
    const db = new FakeD1({ ...level(3), maintenance_message: 'Vuelvo <script>alert(1)</script> & luego' });
    const html = await (await defend(makeCtx(db, { ip: '8.8.8.8' }).ctx)).response!.text();
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('la lista blanca atraviesa el mantenimiento', async () => {
    const db = new FakeD1(level(3)).addAllowRow({ value: '8.8.8.8' });
    assert.equal((await defend(makeCtx(db, { ip: '8.8.8.8' }).ctx)).response, undefined);
  });
});

describe('resiliencia ante fallos de D1', () => {
  // Los fallos simulados provocan console.error esperados; se silencian para no ensuciar la salida.
  before(() => { mock.method(console, 'error', () => undefined); });
  after(() => { mock.restoreAll(); });

  it('sin copia previa y D1 caído: la petición pasa (fail open)', async () => {
    const db = new FakeD1(level(3));
    db.failWhen = () => new Error('D1_ERROR: network connection lost');
    assert.equal((await defend(makeCtx(db, { ip: '9.9.9.9' }).ctx)).response, undefined);
  });

  it('una tabla que falta (migración pendiente) se tolera', async () => {
    const db = new FakeD1(level(3));
    db.failWhen = (sql) => (sql.includes('FROM blocked_ips') ? new Error('D1_ERROR: no such table: blocked_ips: SQLITE_ERROR') : null);
    assert.equal((await defend(makeCtx(db, { ip: '9.9.9.9' }).ctx)).response?.status, 503);
  });

  it('un fallo transitorio conserva la última copia buena y reintenta con calma', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const db = new FakeD1(level(3));
    assert.equal((await defend(makeCtx(db, { ip: '7.7.7.7' }).ctx)).response?.status, 503);

    // Pasa el TTL de 60 s y D1 falla: el mantenimiento NO se levanta
    t.mock.timers.tick(61_000);
    db.failWhen = () => new Error('D1_ERROR: network connection lost');
    db.log.length = 0;
    assert.equal((await defend(makeCtx(db, { ip: '7.7.7.7' }).ctx)).response?.status, 503);
    assert.ok(db.log.length > 0, 'debió intentar refrescar');

    // Durante los 10 s siguientes no vuelve a consultar D1 en cada petición
    t.mock.timers.tick(3_000);
    db.log.length = 0;
    for (let i = 0; i < 20; i++) await defend(makeCtx(db, { ip: '7.7.7.7' }).ctx);
    assert.equal(db.log.length, 0);

    // Pasados los 10 s y con D1 recuperado, vuelve a cargar
    t.mock.timers.tick(8_000);
    db.failWhen = null;
    db.setSettings(level(0));
    assert.equal((await defend(makeCtx(db, { ip: '7.7.7.7' }).ctx)).response, undefined);
  });

  it('invalidateState fuerza la recarga inmediata', async () => {
    const db = new FakeD1(level(0));
    assert.equal((await defend(makeCtx(db, { ip: '7.7.7.7' }).ctx)).response, undefined);
    db.setSettings(level(3));
    assert.equal((await defend(makeCtx(db, { ip: '7.7.7.7' }).ctx)).response, undefined); // aún en caché
    invalidateState();
    assert.equal((await defend(makeCtx(db, { ip: '7.7.7.7' }).ctx)).response?.status, 503);
  });
});
