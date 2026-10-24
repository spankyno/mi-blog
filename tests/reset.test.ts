import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, resetDefenseConfig } from '../src/lib/defense/store';
import { FakeD1 } from './helpers/fake-d1';

/** Ajustes y reglas «de fábrica» tras restablecer, comparables con el estado inicial. */
const DIRTY = {
  defense_enabled: '0', defense_level: '3', defense_prev_level: '2', maintenance_message: 'Mi mensaje', maintenance_eta: '2030-01-01T00:00:00Z',
  defense_lite_skip_logging: '1', defense_auto_ban: '0', defense_autoban_hits: '9', defense_autoban_window_min: '30', defense_autoban_hours: '72',
  defense_auto_purge: '1', defense_alerts_enabled: '0', defense_alert_ip_per_min: '99', defense_alert_wave_5min: '999', defense_alert_cooldown_min: '5',
  defense_auto_escalate: '1', defense_notify_changes: '0', defense_login_alert_fails: '9', defense_scanner_enabled: '0', defense_scanner_hours: '5',
};

describe('Restablecer configuración', () => {
  it('devuelve cada ajuste a su valor por defecto y borra mensaje y hora de mantenimiento', async () => {
    const db = new FakeD1({ ...DIRTY, telegram_enabled: '0', defense_last_alert_ip: '123', defense_last_purge: '2026-10-01' });
    await resetDefenseConfig(db);
    const g = (k: string) => db.settings.get(k);
    assert.deepEqual([g('defense_level'), g('defense_enabled'), g('defense_prev_level')], ['0', '1', '0']);
    assert.deepEqual([g('defense_lite_skip_logging'), g('defense_auto_purge'), g('defense_auto_escalate')], ['0', '0', '0']);
    assert.deepEqual([g('defense_alerts_enabled'), g('defense_notify_changes')], ['1', '1']);
    assert.deepEqual([g('defense_alert_ip_per_min'), g('defense_alert_wave_5min'), g('defense_alert_cooldown_min'), g('defense_login_alert_fails')], ['30', '40', '30', '3']);
    assert.deepEqual([g('defense_auto_ban'), g('defense_autoban_hits'), g('defense_autoban_window_min'), g('defense_autoban_hours')], ['1', '5', '10', '24']);
    assert.deepEqual([g('defense_scanner_enabled'), g('defense_scanner_hours')], ['1', '48']);
    assert.equal(db.settings.has('maintenance_message'), false);
    assert.equal(db.settings.has('maintenance_eta'), false);
  });

  it('no toca el botón general de Telegram ni las marcas internas (último aviso, última poda)', async () => {
    const db = new FakeD1({ ...DIRTY, telegram_enabled: '0', defense_last_alert_ip: '123', defense_last_purge: '2026-10-01' });
    await resetDefenseConfig(db);
    assert.equal(db.settings.get('telegram_enabled'), '0');
    assert.equal(db.settings.get('defense_last_alert_ip'), '123');
    assert.equal(db.settings.get('defense_last_purge'), '2026-10-01');
  });

  it('recrea las 3 reglas originales y descarta las editadas o propias', async () => {
    const db = new FakeD1()
      .addRuleRow({ name: 'Mi regla', scope: 'asn', max_hits: 5, window_s: 30, action: 'limit' })
      .addRuleRow({ name: 'Ráfaga editada', scope: 'ip', max_hits: 3, window_s: 10 });
    await resetDefenseConfig(db);
    assert.deepEqual(db.rules.map((r) => r.name), ['Ráfaga por IP', 'Mismo UA desde muchas IPs', 'Presión global']);
    assert.deepEqual(
      [db.rules[0].scope, db.rules[0].path_pattern, db.rules[0].max_hits, db.rules[0].window_s, db.rules[0].action, db.rules[0].ban_minutes],
      ['ip', '/blog/*', 30, 60, 'ban', 15]
    );
  });

  it('NO toca listas de bloqueo ni blanca, eventos ni visitas', async () => {
    const db = new FakeD1(DIRTY).addBlockRow({ value: '203.0.113.77' }).addAllowRow({ value: '198.51.100.5' });
    db.events.push({ ts: 't', type: 'x', ip: null, detail: 'y' });
    await resetDefenseConfig(db);
    assert.equal(db.blocks.length, 1);
    assert.equal(db.allows.length, 1);
    assert.equal(db.events.length, 1);
    assert.ok(!db.log.some((s) => /page_views|bot_ips|blocked_ips|allow_list|defense_events/.test(s) && /^(DELETE|UPDATE|INSERT)/.test(s)));
  });

  it('los valores por defecto no incluyen claves ajenas a la defensa', () => {
    const keys = Object.keys(defaultSettings());
    assert.ok(keys.every((k) => k.startsWith('defense_') || k.startsWith('maintenance_')));
    assert.ok(!keys.includes('telegram_enabled') && !keys.some((k) => k.startsWith('defense_last_')));
  });
});
