import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defend, recordBotVisit, resetDefenseMemory } from '../src/lib/defense/index';
import { hit, matchPath, resetRateLimiter } from '../src/lib/defense/rate-limiter';
import { isVerifiedSearchCrawler } from '../src/lib/defense/crawlers';
import { FakeD1 } from './helpers/fake-d1';
import { makeCtx } from './helpers/ctx';

const level = (n: number) => ({ defense_level: String(n), defense_enabled: '1' });
const R_IP = { name: 'Ráfaga', scope: 'ip', max_hits: 5, window_s: 60, action: 'ban', ban_minutes: 15 };

beforeEach(() => resetDefenseMemory());

describe('limitador de frecuencia', () => {
  it('cuenta en una ventana deslizante aproximada', () => {
    resetRateLimiter();
    let est = 0;
    for (let i = 0; i < 31; i++) est = hit('k', 60_000, 1_000_000 + i * 100);
    assert.equal(Math.round(est), 31);
  });
  it('olvida tras dos ventanas sin actividad', () => {
    resetRateLimiter();
    for (let i = 0; i < 30; i++) hit('k2', 60_000, 1_000_000);
    assert.equal(Math.round(hit('k2', 60_000, 1_130_000)), 1);
  });
  it('pondera la ventana anterior (30 previas, a mitad de la siguiente ⇒ ~16)', () => {
    resetRateLimiter();
    for (let i = 0; i < 30; i++) hit('k3', 60_000, 1_000_000);
    assert.equal(Math.round(hit('k3', 60_000, 1_090_000)), 16);
  });
  it('matchPath: todo, prefijo, base del prefijo, exacta y falsos amigos', () => {
    assert.equal(matchPath('*', '/x'), true);
    assert.equal(matchPath('/blog/*', '/blog/hola'), true);
    assert.equal(matchPath('/blog/*', '/blog'), true);
    assert.equal(matchPath('/blog/*', '/blogger'), false);
    assert.equal(matchPath('/blog', '/blog'), true);
  });
});

describe('buscadores verificados', () => {
  it('Googlebot desde la red de Google sí; desde otra red no', () => {
    assert.equal(isVerifiedSearchCrawler('Mozilla/5.0 (compatible; Googlebot/2.1)', 15169), true);
    assert.equal(isVerifiedSearchCrawler('Googlebot/2.1', 16276), false);
    assert.equal(isVerifiedSearchCrawler(null, 15169), false);
  });
});

describe('reglas de frecuencia en defend()', () => {
  async function burst(n: number, db: FakeD1, o: Parameters<typeof makeCtx>[1] = {}) {
    resetDefenseMemory();
    let last: Awaited<ReturnType<typeof defend>> | undefined;
    let settle = async () => {};
    for (let i = 0; i < n; i++) { const c = makeCtx(db, o); settle = c.settle; last = await defend(c.ctx); }
    await settle();
    return last!;
  }

  it('hasta el límite pasa; la siguiente recibe 429 con Retry-After y se banea (nivel 2)', async () => {
    const db = new FakeD1(level(2)).addRuleRow(R_IP);
    assert.equal((await burst(5, db)).response, undefined);
    const out = await burst(6, db);
    assert.equal(out.response?.status, 429);
    assert.equal(out.response?.headers.get('Retry-After'), '60');
    assert.ok(db.blockWhere('7.7.7.7'), 'la IP debe quedar en blocked_ips');
    assert.equal(db.blockWhere('7.7.7.7')?.source, 'auto');
  });

  it('nivel 1 y 0: solo marcan, sin 429 ni baneo', async () => {
    for (const n of [0, 1]) {
      const db = new FakeD1(level(n)).addRuleRow(R_IP);
      const out = await burst(6, db);
      assert.equal(out.response, undefined, `nivel ${n}`);
      assert.deepEqual(out.info.flags, ['rule:Ráfaga']);
      assert.equal(db.blocks.length, 0);
    }
  });

  it('acción «limit»: 429 sin baneo', async () => {
    const db = new FakeD1(level(2)).addRuleRow({ ...R_IP, action: 'limit' });
    const out = await burst(6, db);
    assert.equal(out.response?.status, 429);
    assert.equal(db.blocks.length, 0);
  });

  it('las reglas por UA y globales NUNCA bloquean y no marcan (solo aviso)', async () => {
    const ua = await burst(8, new FakeD1(level(2)).addRuleRow({ name: 'UA', scope: 'ua', max_hits: 3, window_s: 60, path_pattern: '*', action: 'ban' }));
    assert.equal(ua.response, undefined);
    assert.deepEqual([ua.info.flags, ua.info.watch], [[], ['watch:UA']]);
    const g = await burst(8, new FakeD1(level(2)).addRuleRow({ name: 'G', scope: 'global', max_hits: 3, window_s: 60, path_pattern: '*', action: 'limit' }));
    assert.equal(g.response, undefined);
  });

  it('Googlebot verificado por ASN queda exento; el falso no', async () => {
    const db = new FakeD1(level(2)).addRuleRow(R_IP);
    const real = await burst(20, db, { ip: '66.249.66.1', ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)', asn: 15169 });
    assert.equal(real.response, undefined);
    const fake = await burst(20, new FakeD1(level(2)).addRuleRow(R_IP), { ip: '66.249.66.1', ua: 'Googlebot/2.1', asn: 16276 });
    assert.ok([429, 403].includes(fake.response?.status ?? 0));
  });

  it('la lista blanca está exenta', async () => {
    const db = new FakeD1(level(2)).addRuleRow(R_IP).addAllowRow({ value: '7.7.7.7' });
    assert.equal((await burst(20, db)).response, undefined);
  });

  it('IPv6: cuenta por /64 aunque cambie la dirección', async () => {
    resetDefenseMemory();
    const db = new FakeD1(level(2)).addRuleRow(R_IP);
    let last: Awaited<ReturnType<typeof defend>> | undefined;
    for (let i = 1; i <= 6; i++) last = await defend(makeCtx(db, { ip: `2001:db8:1:2:aaaa::${i}` }).ctx);
    assert.equal(last!.response?.status, 429);
  });

  it('una ruta fuera de la regla no cuenta', async () => {
    const db = new FakeD1(level(2)).addRuleRow(R_IP);
    assert.equal((await burst(20, db, { path: '/contacto' })).response, undefined);
  });

  it('los avisos de reglas por UA no cuentan como «marcadas» en los contadores', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const db = new FakeD1(level(0)).addRuleRow({ name: 'UA', scope: 'ua', max_hits: 2, window_s: 60, path_pattern: '*' });
    for (let i = 0; i < 5; i++) await defend(makeCtx(db, { ip: `5.5.5.${i}` }).ctx);
    t.mock.timers.tick(61_000);
    const c = makeCtx(db, { ip: '5.5.5.99' });
    await defend(c.ctx); // dispara el volcado de contadores
    await c.settle();
    // Si los avisos contaran como «marcadas», habría un volcado con flagged > 0; no debe haber ninguno.
    assert.equal(db.hourly.length, 0);
  });
});

describe('auto-baneo de reincidentes', () => {
  async function bots(n: number, db: FakeD1, a: Partial<{ ip: string; ua: string; asn: number | null; score: number; reasons: string[] }> = {}) {
    resetDefenseMemory();
    for (let i = 0; i < n; i++) {
      await recordBotVisit({ db, ip: a.ip ?? '5.5.5.5', userAgent: a.ua ?? 'x', asn: a.asn ?? null, score: a.score ?? 100, reasons: a.reasons ?? ['sin-ua'] });
    }
    return db.blocks.some((b) => b.source === 'auto');
  }

  it('con 4 visitas bot aún no; con 5 se crea la entrada automática de 24 h', async () => {
    assert.equal(await bots(4, new FakeD1(level(0))), false);
    const db = new FakeD1(level(0));
    assert.equal(await bots(5, db), true);
    const e = db.blockWhere('5.5.5.5')!;
    const hours = (Date.parse(e.expires_at) - Date.now()) / 3_600_000;
    assert.ok(hours > 23.9 && hours <= 24, `duración ${hours} h`);
  });

  it('el umbral es configurable', async () => {
    assert.equal(await bots(3, new FakeD1({ ...level(0), defense_autoban_hits: '3' }), { ip: '5.5.5.9' }), true);
  });

  it('no cuenta: bots declarados, score bajo, Googlebot verificado, lista blanca, ya listadas, desactivado', async () => {
    assert.equal(await bots(9, new FakeD1(level(0)), { reasons: ['known-bot'] }), false);
    assert.equal(await bots(9, new FakeD1(level(0)), { score: 60 }), false);
    assert.equal(await bots(9, new FakeD1(level(0)), { ua: 'Googlebot/2.1', asn: 15169 }), false);
    assert.equal(await bots(9, new FakeD1(level(0)).addAllowRow({ value: '5.5.5.5' })), false);
    assert.equal(await bots(9, new FakeD1(level(0)).addBlockRow({ value: '5.5.5.5' })), false);
    assert.equal(await bots(9, new FakeD1({ ...level(0), defense_auto_ban: '0' })), false);
  });

  it('respeta el tope de 500 entradas automáticas', async () => {
    const db = new FakeD1(level(0));
    for (let i = 0; i < 500; i++) db.addBlockRow({ value: `10.0.${Math.floor(i / 250)}.${i % 250}`, source: 'auto' });
    const before = db.blocks.length;
    await bots(5, db);
    assert.equal(db.blocks.length, before);
  });

  it('IPv6: cuenta y banea por /64', async () => {
    resetDefenseMemory();
    const db = new FakeD1(level(0));
    for (let i = 1; i <= 5; i++) await recordBotVisit({ db, ip: `2001:db8:9:9::${i}`, userAgent: 'x', asn: null, score: 100, reasons: ['sin-ua'] });
    assert.ok(db.blockWhere('2001:db8:9:9::/64'));
  });
});
