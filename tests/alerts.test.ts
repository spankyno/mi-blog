import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defend, recordBotVisit, resetDefenseMemory } from '../src/lib/defense/index';
import { madridTime, notifyChange, sendAlert, topPathsText } from '../src/lib/defense/alerts';
import { parseIp } from '../src/lib/defense/ip';
import { FakeD1 } from './helpers/fake-d1';
import { makeCtx, TG_ENV } from './helpers/ctx';
import { mockTelegram } from './helpers/telegram';

const base = { defense_level: '0', defense_enabled: '1', defense_alert_ip_per_min: '5', defense_alert_wave_5min: '5' };
let tg: ReturnType<typeof mockTelegram>;

before(() => { tg = mockTelegram(); });
after(() => tg.restore());
beforeEach(() => { resetDefenseMemory(); tg.clear(); });

/** Lanza N peticiones a las rutas dadas desde una IP y espera a que terminen las tareas en segundo plano. */
async function hits(db: FakeD1, ip: string, paths: string[], o: Parameters<typeof makeCtx>[1] = {}) {
  let settle = async () => {};
  for (const path of paths) { const c = makeCtx(db, { ip, path, env: TG_ENV, ...o }); settle = c.settle; await defend(c.ctx); }
  await settle();
}

describe('hora de Madrid', () => {
  it('verano (UTC+2), invierno (UTC+1) y cambio de hora', () => {
    assert.equal(madridTime(Date.UTC(2026, 9, 20, 12, 33, 7)), '20/10/2026 14:33:07');
    assert.equal(madridTime(Date.UTC(2026, 11, 1, 12, 0, 0)), '01/12/2026 13:00:00');
    assert.equal(madridTime(Date.UTC(2026, 2, 29, 1, 30, 0)), '29/03/2026 03:30:00');
  });
});

describe('alerta de ráfaga', () => {
  it('envía UN mensaje con IP, red, páginas con su número, rango horario y navegador', async () => {
    const db = new FakeD1(base);
    await hits(db, '45.138.12.27', ['/<script>x</script>', '/', '/', '/', '/blog', '/blog/hola', '/blog/hola'], { asn: 16276, org: 'OVH SAS', country: 'FR' });
    assert.equal(tg.sent().length, 1);
    const text: string = tg.sent()[0].body.text;
    assert.match(text, /Ráfaga desde una IP/);
    assert.ok(text.includes('45.138.12.27') && text.includes('AS16276') && text.includes('OVH SAS'));
    assert.ok(text.includes('<code>/</code> ×3'), 'la portada con su recuento');
    assert.ok(text.includes('<code>/blog/hola</code> ×1'));
    assert.match(text, /🕒 \d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d → \d\d:\d\d:\d\d \(hora de Madrid\)/);
    assert.ok(text.includes('🖥 <code>Mozilla/5.0 (Macintosh) Chrome/130</code>'));
    assert.match(text, /Nivel actual: 0/);
    assert.ok(!text.includes('<script>'), 'una ruta con <script> nunca llega sin escapar');
    assert.deepEqual(tg.sent()[0].body.reply_markup.inline_keyboard[0][0], { text: '🚫 Bloquear IP (24 h)', callback_data: 'ban:45.138.12.27' });
    assert.equal(tg.sent()[0].body.parse_mode, 'HTML');
  });

  it('queda anotada en el Registro de eventos con las páginas principales', async () => {
    const db = new FakeD1(base);
    await hits(db, '45.138.12.27', ['/', '/', '/', '/blog', '/blog/hola', '/blog/hola']);
    const ev = db.eventsOf('alert')[0];
    assert.equal(ev.ip, '45.138.12.27');
    assert.match(ev.detail, /^Ráfaga: 6 · \/ ×3/);
  });

  it('respeta el tiempo de espera: no repite aviso aunque ataque otra IP', async () => {
    const db = new FakeD1(base);
    await hits(db, '45.138.12.27', Array(8).fill('/'));
    await hits(db, '2001:db8:1:1::5', Array(8).fill('/'));
    assert.equal(tg.sent().length, 1);
  });

  it('no avisa si: alertas desactivadas, Telegram silenciado o falta el token', async () => {
    await hits(new FakeD1({ ...base, defense_alerts_enabled: '0' }), '1.1.1.1', Array(8).fill('/'));
    resetDefenseMemory();
    await hits(new FakeD1({ ...base, telegram_enabled: '0' }), '1.1.1.2', Array(8).fill('/'));
    resetDefenseMemory();
    await hits(new FakeD1(base), '1.1.1.3', Array(8).fill('/'), { env: { ...TG_ENV, TELEGRAM_BOT_TOKEN: undefined } });
    assert.equal(tg.sent().length, 0);
  });

  it('no avisa de IPs de la lista blanca ni durante el mantenimiento', async () => {
    await hits(new FakeD1(base).addAllowRow({ value: '1.1.1.1' }), '1.1.1.1', Array(8).fill('/'));
    resetDefenseMemory();
    await hits(new FakeD1({ ...base, defense_level: '3' }), '1.1.1.2', Array(8).fill('/'));
    assert.equal(tg.sent().length, 0);
  });

  it('dos alertas con el mismo recuento son distintas (cada una con su página y navegador)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3_600_000 });
    const db = new FakeD1(base);
    const state: any = { level: 0, alerts: { enabled: true, ipPerMin: 5, wave5min: 5, cooldownMin: 1, autoEscalate: false, notifyChanges: true }, telegramMuted: false };
    const trail = (p: string, ua: string) => ({ first: 1, last: 2, paths: new Map([[p, 12]]), ua });
    await sendAlert({ kind: 'ip', db, env: TG_ENV, state, count: 31, ip: parseIp('1.1.1.1')!, trail: trail('/a', 'UA-uno') });
    t.mock.timers.tick(5 * 60_000);
    await sendAlert({ kind: 'ip', db, env: TG_ENV, state, count: 31, ip: parseIp('2.2.2.2')!, trail: trail('/b', 'UA-dos') });
    const [a, b] = tg.sent().map((c) => c.body.text as string);
    assert.notEqual(a, b);
    assert.ok(a.includes('/a') && a.includes('UA-uno') && b.includes('/b') && b.includes('UA-dos'));
  });

  it('sin rastro sigue incluyendo la hora de Madrid', async () => {
    const state: any = { level: 0, alerts: { enabled: true, ipPerMin: 5, wave5min: 5, cooldownMin: 1, autoEscalate: false, notifyChanges: true }, telegramMuted: false };
    await sendAlert({ kind: 'ip', db: new FakeD1(), env: TG_ENV, state, count: 40, ip: parseIp('3.3.3.3')! });
    assert.match(tg.sent()[0].body.text, /🕒 \d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d \(hora de Madrid\)/);
  });

  it('la organización de red (dato externo) se escapa', async () => {
    const state: any = { level: 0, alerts: { enabled: true, ipPerMin: 5, wave5min: 5, cooldownMin: 1, autoEscalate: false, notifyChanges: true }, telegramMuted: false };
    await sendAlert({ kind: 'ip', db: new FakeD1(), env: TG_ENV, state, count: 9, ip: parseIp('1.2.3.4')!, geo: { country: 'PL', asn: 1, org: '<script>alert(1)</script> & <b>Co</b>' } });
    const text: string = tg.sent()[0].body.text;
    assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;Co&lt;/b&gt;'));
    assert.ok(!text.includes('<script>'));
  });

  it('topPathsText ordena por número de peticiones y limita a 4', () => {
    const t = { first: 0, last: 0, ua: '', paths: new Map([['/a', 1], ['/b', 5], ['/c', 3], ['/d', 2], ['/e', 4]]) };
    assert.equal(topPathsText(t), '<code>/b</code> ×5, <code>/e</code> ×4, <code>/c</code> ×3, <code>/d</code> ×2');
  });
});

describe('alerta de oleada', () => {
  it('avisa al superar el umbral de bots en 5 min, con hora de Madrid', async () => {
    const db = new FakeD1(base);
    for (let i = 0; i < 8; i++) await recordBotVisit({ db, ip: `9.9.${i}.1`, userAgent: 'x', asn: null, score: 100, reasons: ['sin-ua'], env: TG_ENV });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(tg.sent().length, 1);
    assert.match(tg.sent()[0].body.text, /Oleada de bots/);
    assert.match(tg.sent()[0].body.text, /hora de Madrid/);
  });

  it('las visitas ya contadas en defend() (alreadyFlagged) no se cuentan dos veces', async () => {
    const db = new FakeD1(base);
    for (let i = 0; i < 20; i++) await recordBotVisit({ db, ip: `8.8.${i}.1`, userAgent: 'x', asn: null, score: 100, reasons: ['sin-ua'], env: TG_ENV, alreadyFlagged: true });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(tg.sent().length, 0);
  });

  it('si otro servidor ya reclamó el hueco en D1, este no envía', async () => {
    const db = new FakeD1({ ...base, defense_last_alert_wave: String(Date.now()) });
    for (let i = 0; i < 10; i++) await recordBotVisit({ db, ip: `7.7.${i}.1`, userAgent: 'x', asn: null, score: 100, reasons: ['sin-ua'], env: TG_ENV });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(tg.sent().length, 0);
  });
});

describe('escalada automática y avisos de cambios', () => {
  it('con la escalada activa, una alerta en nivel 0 sube SOLO a nivel 1', async () => {
    const db = new FakeD1();
    const state: any = { level: 0, alerts: { enabled: true, ipPerMin: 5, wave5min: 5, cooldownMin: 1, autoEscalate: true, notifyChanges: true }, telegramMuted: false };
    await sendAlert({ kind: 'wave', db, env: TG_ENV, state, count: 50 });
    assert.equal(db.settings.get('defense_level'), '1');
    assert.match(tg.sent()[0].body.text, /Subido automáticamente a Vigilancia/);
    assert.ok(JSON.stringify(tg.sent()[0].body.reply_markup).includes('lvl:2'), 'el teclado ya refleja el nivel 1');
  });

  it('notifyChange respeta «Telegram ✗» y el ajuste de avisos de cambios', async () => {
    await notifyChange(TG_ENV, new FakeD1(), 'cambio A');
    assert.equal(tg.sent().length, 1);
    tg.clear();
    await notifyChange(TG_ENV, new FakeD1({ telegram_enabled: '0' }), 'cambio B');
    await notifyChange(TG_ENV, new FakeD1({ defense_notify_changes: '0' }), 'cambio C');
    await notifyChange({}, new FakeD1(), 'cambio D');
    assert.equal(tg.sent().length, 0);
  });
});
