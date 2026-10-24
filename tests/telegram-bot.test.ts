import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate } from '../src/lib/defense/telegram-bot';
import { timingSafeEqual } from '../src/lib/defense/telegram-api';
import { resetDefenseMemory } from '../src/lib/defense/index';
import { FakeD1 } from './helpers/fake-d1';
import { TG_ENV } from './helpers/ctx';
import { mockTelegram } from './helpers/telegram';

let tg: ReturnType<typeof mockTelegram>;
before(() => { tg = mockTelegram(); });
after(() => tg.restore());
beforeEach(() => { resetDefenseMemory(); tg.clear(); });

const cb = (data: string, over: Record<string, any> = {}) => ({
  callback_query: { id: 'cb1', data, from: { id: 111 }, message: { message_id: 7, chat: { id: 111 } }, ...over },
});
async function press(data: string, settings: Record<string, string> = {}, over: Record<string, any> = {}, env: Record<string, any> = TG_ENV) {
  const db = new FakeD1({ defense_level: '0', ...settings });
  tg.clear();
  await handleUpdate(cb(data, over), { ...env, DB: db } as any, db);
  return db;
}

describe('timingSafeEqual', () => {
  it('compara en tiempo constante', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
  });
});

describe('botones del mensaje', () => {
  it('lvl:2 aplica el nivel, responde, quita el teclado y avisa', async () => {
    const db = await press('lvl:2');
    assert.equal(db.settings.get('defense_level'), '2');
    assert.deepEqual([tg.sent('answerCallbackQuery').length, tg.sent('editMessageReplyMarkup').length, tg.sent().length], [1, 1, 1]);
  });

  it('lvl:3 no existe como botón directo', async () => {
    assert.equal((await press('lvl:3')).settings.get('defense_level'), '0');
  });

  it('mnt:on solo pide confirmación; mnt:yes activa y recuerda el nivel previo; mnt:off lo restaura', async () => {
    const on = await press('mnt:on');
    assert.equal(on.settings.get('defense_level'), '0');
    assert.ok(JSON.stringify(tg.sent('editMessageReplyMarkup')[0].body.reply_markup).includes('mnt:yes'));
    const yes = await press('mnt:yes', { defense_level: '2' });
    assert.deepEqual([yes.settings.get('defense_level'), yes.settings.get('defense_prev_level')], ['3', '2']);
    const off = await press('mnt:off', { defense_level: '3', defense_prev_level: '1' });
    assert.equal(off.settings.get('defense_level'), '1');
  });

  it('ban:<IPv6> bloquea su /64 con origen «telegram»', async () => {
    const db = await press('ban:2001:db8:7:7:aaaa::9');
    assert.deepEqual([db.blocks[0]?.kind, db.blocks[0]?.value, db.blocks[0]?.source], ['cidr', '2001:db8:7:7::/64', 'telegram']);
    const text: string = tg.sent()[0].body.text;
    assert.ok(text.includes('solo se <b>marca</b>'), 'a nivel 0 avisa de que solo marca');
    assert.ok(JSON.stringify(tg.sent()[0].body.reply_markup).includes('lvl:2'), 'ofrece subir a Defensa');
  });

  it('ban a nivel 2: «Ya está activa»; IP inválida: no inserta nada', async () => {
    await press('ban:1.2.3.4', { defense_level: '2' });
    assert.ok(tg.sent()[0].body.text.includes('Ya está activa'));
    assert.equal((await press('ban:no-es-una-ip')).blocks.length, 0);
  });

  it('ign solo responde y quita el teclado', async () => {
    await press('ign');
    assert.deepEqual([tg.sent('answerCallbackQuery').length, tg.sent('editMessageReplyMarkup').length, tg.sent().length], [1, 1, 0]);
  });

  it('una acción desconocida se rechaza sin cambiar nada', async () => {
    const db = await press('hack:1');
    assert.equal(db.settings.get('defense_level'), '0');
    assert.equal(tg.sent('answerCallbackQuery')[0].body.text, 'Acción desconocida');
  });
});

describe('autorización', () => {
  it('un chat ajeno no puede cambiar nada', async () => {
    const db = await press('lvl:2', {}, { message: { message_id: 7, chat: { id: 999 } } });
    assert.equal(db.settings.get('defense_level'), '0');
    assert.equal(tg.sent('answerCallbackQuery')[0].body.text, 'No autorizado');
  });
  it('en un chat privado, otro usuario tampoco', async () => {
    assert.equal((await press('lvl:2', {}, { from: { id: 222 } })).settings.get('defense_level'), '0');
  });
  it('en un grupo configurado se acepta (la doc avisa del riesgo)', async () => {
    const db = await press('lvl:2', {}, { from: { id: 222 }, message: { message_id: 7, chat: { id: -100123 } } }, { ...TG_ENV, TELEGRAM_CHAT_ID: '-100123' });
    assert.equal(db.settings.get('defense_level'), '2');
  });
});

describe('/estado', () => {
  it('responde al dueño con nivel y contadores; ignora a desconocidos y textos cualquiera', async () => {
    const db = new FakeD1({ defense_level: '1' });
    db.hourly.push({ hour: new Date().toISOString().slice(0, 13), flagged: 3, limited: 1, blocked: 1, maint: 0 });
    await handleUpdate({ message: { text: '/estado', chat: { id: 111 }, from: { id: 111 } } }, { ...TG_ENV, DB: db } as any, db);
    const text: string = tg.sent()[0].body.text;
    assert.ok(text.includes('Nivel actual: 1') && text.includes('marcadas: 3') && text.includes('bloqueadas: 2'));

    tg.clear();
    await handleUpdate({ message: { text: '/estado', chat: { id: 5 }, from: { id: 5 } } }, { ...TG_ENV, DB: db } as any, db);
    await handleUpdate({ message: { text: 'hola', chat: { id: 111 }, from: { id: 111 } } }, { ...TG_ENV, DB: db } as any, db);
    assert.equal(tg.calls.length, 0);
  });
});
