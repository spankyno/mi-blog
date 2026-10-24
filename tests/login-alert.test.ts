import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loginFailureAlert } from '../src/lib/defense/alerts';
import { resetDefenseMemory } from '../src/lib/defense/index';
import { FakeD1 } from './helpers/fake-d1';
import { TG_ENV } from './helpers/ctx';
import { mockTelegram } from './helpers/telegram';

let tg: ReturnType<typeof mockTelegram>;
before(() => { tg = mockTelegram(); });
after(() => { tg.restore(); mock.restoreAll(); });
beforeEach(() => { resetDefenseMemory(); tg.clear(); });

const fail = (db: FakeD1, failures: number, over: Record<string, any> = {}) =>
  loginFailureAlert({ db, env: TG_ENV, ip: '203.0.113.50', failures, windowMin: 15, maxAttempts: 5, user: 'admin', ua: 'Mozilla/5.0 Test', geo: { country: 'RU', asn: 12389, org: 'Rostelecom' }, ...over });

describe('aviso de fallos de acceso al panel', () => {
  it('avisa SOLO al alcanzar el umbral (3): ni antes ni después', async () => {
    const db = new FakeD1();
    for (const n of [1, 2]) await fail(db, n);
    assert.equal(tg.sent().length, 0, 'con 1 o 2 fallos no avisa');
    await fail(db, 3);
    assert.equal(tg.sent().length, 1, 'al 3.º avisa');
    for (const n of [4, 5]) await fail(db, n);
    assert.equal(tg.sent().length, 1, 'con 4 o 5 no repite');
  });

  it('el mensaje trae IP, red, usuario probado, navegador, hora de Madrid y el límite de bloqueo', async () => {
    await fail(new FakeD1(), 3);
    const text: string = tg.sent()[0].body.text;
    assert.match(text, /Fallos de acceso al panel/);
    assert.ok(text.includes('203.0.113.50') && text.includes('RU') && text.includes('AS12389') && text.includes('Rostelecom'));
    assert.ok(text.includes('3 intentos fallidos en 15 min'));
    assert.ok(text.includes('<code>admin</code>'));
    assert.ok(text.includes('Mozilla/5.0 Test'));
    assert.match(text, /\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d \(hora de Madrid\)/);
    assert.ok(text.includes('Tras 5 fallos'));
  });

  it('no lleva botones (el panel está fuera de la defensa) y queda en el Registro de eventos', async () => {
    const db = new FakeD1();
    await fail(db, 3);
    assert.equal(tg.sent()[0].body.reply_markup, undefined);
    assert.equal(db.eventsOf('login_alert').length, 1);
    assert.equal(db.eventsOf('login_alert')[0].ip, '203.0.113.50');
  });

  it('el usuario y el navegador (datos del atacante) se escapan y se recortan', async () => {
    await fail(new FakeD1(), 3, { user: '<script>alert(1)</script>' + 'x'.repeat(100), ua: '<b>' + 'y'.repeat(300) });
    const text: string = tg.sent()[0].body.text;
    assert.ok(!text.includes('<script>') && !text.includes('<b>y'));
    assert.ok(text.includes('&lt;script&gt;'));
    assert.ok(!text.includes('x'.repeat(60)), 'el usuario se recorta a 40 caracteres');
    assert.ok(!text.includes('y'.repeat(150)), 'el navegador se recorta a 120 caracteres');
  });

  it('el umbral es configurable; con 0 no avisa nunca', async () => {
    const five = new FakeD1({ defense_login_alert_fails: '5' });
    await fail(five, 3);
    assert.equal(tg.sent().length, 0);
    await fail(five, 5);
    assert.equal(tg.sent().length, 1);
    resetDefenseMemory(); tg.clear();
    const off = new FakeD1({ defense_login_alert_fails: '0' });
    for (const n of [1, 2, 3, 4, 5]) await fail(off, n);
    assert.equal(tg.sent().length, 0);
  });

  it('respeta «Alertas activas», el botón «Telegram ✓/✗» y la falta de token', async () => {
    await fail(new FakeD1({ defense_alerts_enabled: '0' }), 3);
    resetDefenseMemory();
    await fail(new FakeD1({ telegram_enabled: '0' }), 3);
    resetDefenseMemory();
    await fail(new FakeD1(), 3, { env: {} });
    assert.equal(tg.sent().length, 0);
  });

  it('si D1 no responde, avisa igualmente con el umbral por defecto', async () => {
    mock.method(console, 'error', () => undefined);
    const db = new FakeD1();
    db.failWhen = () => new Error('D1_ERROR: network connection lost');
    await loginFailureAlert({ db, env: TG_ENV, ip: '1.2.3.4', failures: 3, windowMin: 15, maxAttempts: 5, user: 'admin' });
    assert.equal(tg.sent().length, 1);
  });
});
