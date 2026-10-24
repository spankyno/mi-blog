import type { APIRoute } from 'astro';
import { LEVELS, ALERT_DEFAULTS, ENFORCEABLE_SCOPES, MAX_RULES, type DefenseLevel, type EntryKind, type RuleAction, type RuleScope } from '../../../lib/defense/config';
import { runPurge } from '../../../lib/defense/purge';
import { applyLevel, applyMaintenance } from '../../../lib/defense/actions';
import { notifyChange } from '../../../lib/defense/alerts';
import { esc, getWebhookInfo, sendMessage, setWebhook } from '../../../lib/defense/telegram-api';
import { addToList, emptyList, findMatch, normalizeValue } from '../../../lib/defense/blocklist';
import { parseIp, ipv6Slash64 } from '../../../lib/defense/ip';
import { invalidateState } from '../../../lib/defense/cache';
import {
  addAllow,
  addBlock,
  countRules,
  deleteRule,
  getSetting,
  logEvent,
  removeAllow,
  resetDefenseConfig,
  removeBlock,
  saveRule,
  seedDefaultRules,
  setRuleEnabled,
  setSetting,
} from '../../../lib/defense/store';

// POST /api/panel/defense  (protegido por el middleware JWT del panel)
// Cuerpo JSON: { action: '...', ...datos }
//   set_level        { level: 0..3 }
//   set_enabled      { enabled: boolean }
//   set_maintenance  { on: boolean, message?: string, eta?: string(ISO) | '' }
//   add_block        { kind, value, reason?, duration_min?, ipv6_64?, force? }
//   remove_block     { id }
//   add_allow        { kind, value, note? }
//   remove_allow     { id }
//   rule_save        { id?, name, scope, path_pattern, max_hits, window_s, rule_action, ban_minutes }
//   rule_toggle      { id, enabled }
//   rule_delete      { id }
//   rules_defaults   {}                          (solo si no hay reglas)
//   set_autoban      { enabled, hits, window_min, hours }
//   set_lite         { enabled }
//   set_auto_purge   { enabled }
//   purge_now        {}
//   reset_config     {}                          (ajustes y reglas a valores de fábrica; no toca listas)
//   set_alerts       { enabled, ip_per_min, wave_5min, cooldown_min, auto_escalate, notify_changes, login_fails }
//   set_scanner      { enabled, hours }
//   telegram_test / telegram_set_webhook / telegram_webhook_info

const KINDS: EntryKind[] = ['ip', 'cidr', 'asn', 'country'];

export const POST: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return json({ ok: false, error: 'DB no disponible' }, 500);

  // Defensa en profundidad frente a CSRF (la cookie ya es SameSite=Strict).
  const origin = request.headers.get('origin');
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === new URL(request.url).host; } catch { /* Origin: null u otro valor inválido */ }
    if (!sameOrigin) return json({ ok: false, error: 'Origen no permitido' }, 403);
  }
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    return json({ ok: false, error: 'Content-Type debe ser application/json' }, 415);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'JSON inválido' }, 400);
  }

  const myIp = request.headers.get('cf-connecting-ip');
  const cf = (locals.runtime as any)?.cf;
  const env = ((locals.runtime as any)?.env ?? {}) as any;
  const waitUntil = (locals.runtime as any)?.ctx?.waitUntil?.bind((locals.runtime as any).ctx) as ((p: Promise<unknown>) => void) | undefined;
  /** Aviso a Telegram de cambios hechos desde el panel (sin bloquear la respuesta). */
  const notify = (text: string) => {
    const p = notifyChange(env, db, text);
    if (waitUntil) waitUntil(p);
  };

  try {
    switch (body?.action) {
      case 'set_level': {
        const level = Number(body.level);
        if (!Number.isInteger(level) || level < 0 || level > 3) return json({ ok: false, error: 'Nivel inválido' }, 400);
        await applyLevel(db, level as DefenseLevel, myIp, 'panel');
        notify(`🛡 Nivel de defensa: <b>${level} · ${esc(LEVELS[level as DefenseLevel].name)}</b>\nCambiado desde el panel (IP <code>${esc(myIp ?? '?')}</code>).`);
        break;
      }

      case 'set_enabled': {
        await setSetting(db, 'defense_enabled', body.enabled ? '1' : '0');
        await logEvent(db, 'enabled', myIp, body.enabled ? 'Defensa activada' : 'Defensa desactivada (interruptor maestro)');
        break;
      }

      case 'set_maintenance': {
        if (body.on) {
          const message = String(body.message ?? '').trim().slice(0, 500);
          let eta = '';
          if (body.eta) {
            const t = Date.parse(String(body.eta));
            if (!Number.isFinite(t)) return json({ ok: false, error: 'Fecha estimada inválida' }, 400);
            eta = new Date(t).toISOString();
          }
          await applyMaintenance(db, true, { message: message || undefined, eta }, myIp, 'panel');
          notify(`🔧 <b>Mantenimiento ACTIVADO</b> desde el panel (IP <code>${esc(myIp ?? '?')}</code>).`);
        } else {
          const restored = await applyMaintenance(db, false, {}, myIp, 'panel');
          notify(`✅ <b>Mantenimiento desactivado</b> desde el panel. Nivel ${restored} · ${esc(LEVELS[restored].name)}.`);
        }
        break;
      }

      case 'add_block':
      case 'add_allow': {
        const kind = body.kind as EntryKind;
        if (!KINDS.includes(kind)) return json({ ok: false, error: 'Tipo inválido' }, 400);

        let value = normalizeValue(kind, String(body.value ?? ''));
        if (!value) {
          return json({ ok: false, error: 'Valor no válido para el tipo elegido (IP, CIDR, ASN o país de 2 letras; prefijo mínimo /8 en IPv4 y /16 en IPv6)' }, 400);
        }

        // Atajo: bloquear el /64 completo de una IPv6.
        let useKind: EntryKind = kind;
        if (body.action === 'add_block' && kind === 'ip' && body.ipv6_64) {
          const p = parseIp(value);
          const net = p ? ipv6Slash64(p) : null;
          if (!net) return json({ ok: false, error: 'La opción /64 solo aplica a IPv6' }, 400);
          useKind = 'cidr';
          value = net;
        }

        if (body.action === 'add_allow') {
          await addAllow(db, { kind: useKind, value, note: String(body.note ?? '').slice(0, 200) });
          await logEvent(db, 'allow_add', myIp, `${useKind}:${value}`);
        } else {
          // Aviso si la entrada incluiría al propio administrador.
          if (!body.force) {
            const probe = emptyList();
            addToList(probe, { kind: useKind, value, source: 'manual' });
            const hitsMe = findMatch(probe, { ip: parseIp(myIp), asn: typeof cf?.asn === 'number' ? cf.asn : null, country: cf?.country ?? null });
            if (hitsMe) {
              return json({ ok: false, needsForce: true, error: 'Esta entrada incluiría tu propia conexión. El panel nunca se bloquea, pero tú tampoco verías el blog público.' }, 409);
            }
          }
          const minutes = Math.floor(Number(body.duration_min ?? 0));
          if (!Number.isFinite(minutes) || minutes < 0 || minutes > 525_600) {
            return json({ ok: false, error: 'Duración inválida' }, 400);
          }
          const expiresAt = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
          await addBlock(db, {
            kind: useKind,
            value,
            reason: String(body.reason ?? '').trim().slice(0, 200) || undefined,
            source: 'manual',
            expiresAt,
          });
          await logEvent(db, 'block_add', myIp, `${useKind}:${value}${expiresAt ? ` hasta ${expiresAt}` : ' (permanente)'}`);
        }
        break;
      }

      case 'remove_block':
      case 'remove_allow': {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: 'ID inválido' }, 400);
        if (body.action === 'remove_block') await removeBlock(db, id);
        else await removeAllow(db, id);
        await logEvent(db, body.action === 'remove_block' ? 'block_remove' : 'allow_remove', myIp, `id ${id}`);
        break;
      }

      case 'rule_save': {
        const name = String(body.name ?? '').trim().slice(0, 60);
        const scope = body.scope as RuleScope;
        const pathPattern = String(body.path_pattern ?? '').trim();
        const maxHits = Math.floor(Number(body.max_hits));
        const windowS = Math.floor(Number(body.window_s));
        const banMinutes = Math.floor(Number(body.ban_minutes ?? 15));
        let action = body.rule_action as RuleAction;

        if (!name) return json({ ok: false, error: 'Pon un nombre a la regla' }, 400);
        if (!['ip', 'ua', 'asn', 'global'].includes(scope)) return json({ ok: false, error: 'Ámbito inválido' }, 400);
        if (!/^(\*|\/[A-Za-z0-9_\-./]*(\/\*)?)$/.test(pathPattern) || pathPattern.length > 100) {
          return json({ ok: false, error: 'Ruta inválida: usa *, una ruta exacta (/blog) o un prefijo (/blog/*)' }, 400);
        }
        if (!Number.isInteger(maxHits) || maxHits < 1 || maxHits > 100_000) return json({ ok: false, error: 'Límite de visitas inválido (1–100000)' }, 400);
        if (!Number.isInteger(windowS) || windowS < 5 || windowS > 3600) return json({ ok: false, error: 'Ventana inválida (5–3600 s)' }, 400);
        if (!['flag', 'limit', 'ban'].includes(action)) return json({ ok: false, error: 'Acción inválida' }, 400);
        if (!Number.isInteger(banMinutes) || banMinutes < 1 || banMinutes > 10_080) return json({ ok: false, error: 'Duración de baneo inválida (1–10080 min)' }, 400);
        if (!ENFORCEABLE_SCOPES.includes(scope)) action = 'flag'; // UA y global solo avisan

        const id = body.id ? Number(body.id) : undefined;
        if (id !== undefined && (!Number.isInteger(id) || id < 1)) return json({ ok: false, error: 'ID inválido' }, 400);
        if (!id && (await countRules(db)) >= MAX_RULES) return json({ ok: false, error: `Máximo ${MAX_RULES} reglas` }, 400);

        await saveRule(db, { name, scope, pathPattern, maxHits, windowS, action, banMinutes }, id);
        await logEvent(db, 'rule_save', myIp, `${name}: ${scope} ${maxHits}/${windowS}s ${pathPattern} → ${action}`);
        break;
      }

      case 'rule_toggle': {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: 'ID inválido' }, 400);
        await setRuleEnabled(db, id, !!body.enabled);
        await logEvent(db, 'rule_toggle', myIp, `regla ${id} ${body.enabled ? 'activada' : 'desactivada'}`);
        break;
      }

      case 'rule_delete': {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: 'ID inválido' }, 400);
        await deleteRule(db, id);
        await logEvent(db, 'rule_delete', myIp, `regla ${id} eliminada`);
        break;
      }

      case 'rules_defaults': {
        const done = await seedDefaultRules(db);
        if (!done) return json({ ok: false, error: 'Ya hay reglas; bórralas antes de restaurar las de fábrica' }, 400);
        await logEvent(db, 'rule_save', myIp, 'Reglas por defecto restauradas');
        break;
      }

      case 'set_autoban': {
        const hits = Math.floor(Number(body.hits));
        const windowMin = Math.floor(Number(body.window_min));
        const hours = Math.floor(Number(body.hours));
        if (!Number.isInteger(hits) || hits < 2 || hits > 100) return json({ ok: false, error: 'Nº de visitas inválido (2–100)' }, 400);
        if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 1440) return json({ ok: false, error: 'Ventana inválida (1–1440 min)' }, 400);
        if (!Number.isInteger(hours) || hours < 1 || hours > 8760) return json({ ok: false, error: 'Duración inválida (1–8760 h)' }, 400);
        await setSetting(db, 'defense_auto_ban', body.enabled ? '1' : '0');
        await setSetting(db, 'defense_autoban_hits', String(hits));
        await setSetting(db, 'defense_autoban_window_min', String(windowMin));
        await setSetting(db, 'defense_autoban_hours', String(hours));
        await logEvent(db, 'autoban', myIp, `${body.enabled ? 'ON' : 'OFF'}: ${hits} visitas bot en ${windowMin} min → ${hours} h`);
        break;
      }

      case 'set_lite': {
        await setSetting(db, 'defense_lite_skip_logging', body.enabled ? '1' : '0');
        await logEvent(db, 'lite', myIp, body.enabled ? 'Modo lite: no registrar visitas ya marcadas' : 'Modo lite desactivado');
        break;
      }

      case 'set_auto_purge': {
        await setSetting(db, 'defense_auto_purge', body.enabled ? '1' : '0');
        await logEvent(db, 'purge', myIp, body.enabled ? 'Poda automática diaria ACTIVADA' : 'Poda automática desactivada');
        break;
      }

      case 'purge_now': {
        const r = await runPurge(db);
        const total = Object.values(r).reduce((a, b) => a + b, 0);
        await logEvent(db, 'purge', myIp, `Poda manual: ${total} filas (bots ${r.botViews}, humanas ${r.humanViews}, bot_ips ${r.botIps}, eventos ${r.events}, horas ${r.hourly}, bloqueos caducados ${r.expiredBlocks})`);
        invalidateState();
        return json({ ok: true, purged: r });
      }

      case 'reset_config': {
        await resetDefenseConfig(db);
        await logEvent(db, 'reset', myIp, 'Configuración restablecida a los valores por defecto (listas y datos intactos)');
        notify(`♻️ <b>Configuración de defensa restablecida</b> a los valores por defecto desde el panel (IP <code>${esc(myIp ?? '?')}</code>).`);
        break;
      }

      case 'set_scanner': {
        const hours = Math.floor(Number(body.hours));
        if (!Number.isInteger(hours) || hours < 1 || hours > 720) return json({ ok: false, error: 'Duración inválida (1–720 horas)' }, 400);
        await setSetting(db, 'defense_scanner_enabled', body.enabled ? '1' : '0');
        await setSetting(db, 'defense_scanner_hours', String(hours));
        await logEvent(db, 'scanner', myIp, `Detector de escáneres ${body.enabled ? 'ON' : 'OFF'}: baneo de ${hours} h`);
        break;
      }

      case 'set_alerts': {
        const ipPerMin = Math.floor(Number(body.ip_per_min));
        const wave5 = Math.floor(Number(body.wave_5min));
        const cooldown = Math.floor(Number(body.cooldown_min));
        const loginFails = Math.floor(Number(body.login_fails ?? 3));
        if (!Number.isInteger(ipPerMin) || ipPerMin < 5 || ipPerMin > 10_000) return json({ ok: false, error: 'Umbral de ráfaga inválido (5–10000)' }, 400);
        if (!Number.isInteger(wave5) || wave5 < 5 || wave5 > 100_000) return json({ ok: false, error: 'Umbral de oleada inválido (5–100000)' }, 400);
        if (!Number.isInteger(cooldown) || cooldown < 1 || cooldown > 1440) return json({ ok: false, error: 'Cooldown inválido (1–1440 min)' }, 400);
        if (!Number.isInteger(loginFails) || loginFails < 0 || loginFails > 50) return json({ ok: false, error: 'Fallos de acceso inválidos (0–50; 0 = no avisar)' }, 400);
        await setSetting(db, 'defense_alerts_enabled', body.enabled ? '1' : '0');
        await setSetting(db, 'defense_alert_ip_per_min', String(ipPerMin));
        await setSetting(db, 'defense_alert_wave_5min', String(wave5));
        await setSetting(db, 'defense_alert_cooldown_min', String(cooldown));
        await setSetting(db, 'defense_auto_escalate', body.auto_escalate ? '1' : '0');
        await setSetting(db, 'defense_notify_changes', body.notify_changes ? '1' : '0');
        await setSetting(db, 'defense_login_alert_fails', String(loginFails));
        await logEvent(db, 'alerts', myIp, `Alertas ${body.enabled ? 'ON' : 'OFF'}: ráfaga ${ipPerMin}/min, oleada ${wave5}/5min, cooldown ${cooldown} min, auto-escalada ${body.auto_escalate ? 'sí' : 'no'}, aviso de acceso al panel ${loginFails > 0 ? `a los ${loginFails} fallos` : 'desactivado'}`);
        break;
      }

      case 'telegram_test': {
        const r = await sendMessage(env, '✅ <b>Prueba de alertas</b>\nSi ves este mensaje, el bot puede escribirte. Estos son los botones que recibirás en una alerta real (en la prueba no hacen nada importante):', [[{ text: 'Ignorar', callback_data: 'ign' }]]);
        if (!r.ok) return json({ ok: false, error: `Telegram: ${r.description ?? 'error'}` }, 502);
        return json({ ok: true });
      }

      case 'telegram_set_webhook': {
        if (!env.TELEGRAM_WEBHOOK_SECRET) {
          return json({ ok: false, error: 'Falta el secret TELEGRAM_WEBHOOK_SECRET en Cloudflare Pages (solo letras, números, _ y -).' }, 400);
        }
        if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
          return json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET debe tener 16–256 caracteres: letras, números, _ y -.' }, 400);
        }
        const url = `${new URL(request.url).origin}/api/telegram/webhook`;
        const r = await setWebhook(env, url);
        if (!r.ok) return json({ ok: false, error: `Telegram: ${r.description ?? 'error'}` }, 502);
        await logEvent(db, 'webhook', myIp, `Webhook registrado: ${url}`);
        return json({ ok: true, url });
      }

      case 'telegram_webhook_info': {
        const r = await getWebhookInfo(env);
        if (!r.ok) return json({ ok: false, error: `Telegram: ${r.description ?? 'error'}` }, 502);
        const i = r.result ?? {};
        return json({
          ok: true,
          url: i.url ?? '',
          pending: i.pending_update_count ?? 0,
          lastError: i.last_error_message ?? null,
          lastErrorDate: i.last_error_date ? new Date(i.last_error_date * 1000).toISOString() : null,
        });
      }

      default:
        return json({ ok: false, error: 'Acción desconocida' }, 400);
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/no such table|no such column/i.test(msg)) {
      return json({ ok: false, error: 'Faltan las tablas de defensa: ejecuta la migración db/migrations/0001_defense_tables.sql' }, 500);
    }
    console.error('defense API error:', e);
    return json({ ok: false, error: 'Error interno' }, 500);
  }

  // Este isolate ve el cambio al instante; el resto, en ≤ 60 s.
  invalidateState();
  return json({ ok: true });
};

function json(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
