// src/lib/defense/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// API pública del módulo de defensa. Se llama desde src/middleware.ts y, para
// el auto-baneo, desde src/pages/blog/[slug].astro.
//
// Principios:
//  · Sin consultas a D1/KV por petición: todo sale de la caché en memoria.
//  · Fail open: si algo falla, la petición pasa.
//  · Panel y webhook de Telegram nunca se tocan (ver isDefenseExempt).
//  · Solo se bloquea en nivel ≥ 2. En niveles 0–1 todo se limita a marcar.
// ─────────────────────────────────────────────────────────────────────────────
import { getState } from './cache';
import { addToList, findMatch } from './blocklist';
import { count, maybeFlush } from './counters';
import { forbiddenResponse, maintenanceResponse, tooManyRequestsResponse } from './maintenance';
import { ipv6Slash64, parseIp, type ParsedIp } from './ip';
import { hit, matchPath } from './rate-limiter';
import { isVerifiedSearchCrawler } from './crawlers';
import { maybeAutoPurge } from './purge';
import { addBlock, countActiveAutoBlocks, logEvent, type DefenseState } from './store';
import { botWave, ipBurst, sendAlert } from './alerts';
import { AUTOBAN_DEFAULTS, ENFORCEABLE_SCOPES, type DefenseInfo, type Rule } from './config';

export { isDefenseExempt } from './config';
export type { DefenseInfo } from './config';

export interface DefenseOutcome {
  /** Si existe, el middleware debe devolverla en vez de continuar. */
  response?: Response;
  info: DefenseInfo;
}

interface Ctx {
  request: Request;
  locals: any;
}

type WaitUntil = ((p: Promise<unknown>) => void) | undefined;

const recentBans = new Map<string, number>();
const botHits = new Map<string, number[]>();
let lastPurgeCheck = 0;

/** IPv4 exacta o /64 en IPv6: la unidad que se cuenta y se banea. */
function subjectOf(ip: ParsedIp): { kind: 'ip' | 'cidr'; value: string } {
  return ip.family === 6 ? { kind: 'cidr', value: ipv6Slash64(ip)! } : { kind: 'ip', value: ip.text };
}

/**
 * Añade un bloqueo temporal automático. Surte efecto al instante en este
 * isolate (se inserta en la caché) y en el resto en ≤ 60 s (vía D1).
 */
function banSubject(
  db: any,
  state: DefenseState,
  ip: ParsedIp,
  minutes: number,
  reason: string
): Promise<void> {
  const { kind, value } = subjectOf(ip);
  const key = `${kind}:${value}`;
  const now = Date.now();
  if ((recentBans.get(key) ?? 0) > now) return Promise.resolve(); // ya baneada hace poco
  if (recentBans.size > 2000) recentBans.clear();
  recentBans.set(key, now + minutes * 60_000);

  addToList(state.blocks, { kind, value, source: 'auto', reason });

  return (async () => {
    if ((await countActiveAutoBlocks(db)) >= AUTOBAN_DEFAULTS.maxAutoEntries) return; // tope
    await addBlock(db, {
      kind,
      value,
      reason,
      source: 'auto',
      expiresAt: new Date(now + minutes * 60_000).toISOString(),
    });
    await logEvent(db, 'auto_ban', ip.text, `${reason} (${minutes} min)`);
  })().catch((e) => console.error('defense: error guardando baneo automático:', e));
}

export async function defend({ request, locals }: Ctx): Promise<DefenseOutcome> {
  const pass: DefenseOutcome = { info: { level: 0, flags: [] } };

  try {
    const runtime = locals?.runtime;
    const db = runtime?.env?.DB;
    if (!db) return pass;

    const state = await getState(db);
    if (!state || !state.enabled) return pass;

    const info: DefenseInfo = { level: state.level, flags: [], lite: state.liteSkipLogging };
    const waitUntil = runtime?.ctx?.waitUntil?.bind(runtime.ctx) as WaitUntil;

    // Tareas de fondo (no bloquean la respuesta).
    const flush = maybeFlush(db);
    if (flush && waitUntil) waitUntil(flush);
    if (state.autoPurge && waitUntil && Date.now() - lastPurgeCheck > 3_600_000) {
      lastPurgeCheck = Date.now();
      waitUntil(maybeAutoPurge(db).catch((e) => console.error('defense: error en poda automática:', e)));
    }

    const ip = parseIp(request.headers.get('cf-connecting-ip'));
    const pathname = new URL(request.url).pathname;
    const cf = runtime?.cf;
    const asn = typeof cf?.asn === 'number' ? cf.asn : null;
    const subject = {
      ip,
      asn,
      country: (cf?.country as string | undefined) ?? request.headers.get('cf-ipcountry'),
    };

    const env = runtime?.env;
    /** Cuenta una visita de bot para la alerta de «oleada» (y avisa si toca). */
    const waveTick = () => {
      if (!state.alerts.enabled || !waitUntil) return;
      const n = botWave(state);
      if (n !== null) waitUntil(sendAlert({ kind: 'wave', db, env, state, count: n }));
    };

    // 1. Lista blanca: gana a todo lo demás.
    if (state.allows.size > 0 && findMatch(state.allows, subject)) {
      return { info };
    }

    // 2. Mantenimiento.
    if (state.level === 3) {
      count('maint');
      return { response: maintenanceResponse(state.maintenanceMessage, state.maintenanceEta), info };
    }

    // 2b. Alerta de ráfaga: una IP (o /64) supera N visitas en 60 s.
    if (ip && state.alerts.enabled && waitUntil) {
      const burst = ipBurst(state, ip, { path: pathname, ua: request.headers.get('user-agent') });
      if (burst !== null) {
        waitUntil(
          sendAlert({
            kind: 'ip', db, env, state, count: burst.count, trail: burst.trail, ip,
            geo: { country: subject.country, asn, org: cf?.asOrganization ?? null },
          })
        );
      }
    }

    // 3. Lista negra: solo marca, o bloquea en nivel ≥ 2 si la entrada no es del honeypot.
    if (state.blocks.size > 0) {
      const hitEntry = findMatch(state.blocks, subject);
      if (hitEntry) {
        if (state.level >= 2 && hitEntry.source !== 'honeypot') {
          count('blocked');
          waveTick();
          return { response: forbiddenResponse(), info };
        }
        count('flagged');
        info.flags.push(`blocklist:${hitEntry.source}`);
      }
    }

    // 4. Reglas de frecuencia («X visitas cada Y tiempo»), en memoria.
    const ua = request.headers.get('user-agent');
    if (state.rules.length > 0 && !isVerifiedSearchCrawler(ua, asn)) {
      const path = pathname;
      const ipUnit = ip ? subjectOf(ip).value : null;
      let enforce: Rule | null = null;
      let ruleFlagged = false;

      for (const rule of state.rules) {
        if (!matchPath(rule.pathPattern, path)) continue;

        let key: string | null = null;
        if (rule.scope === 'ip') key = ipUnit;
        else if (rule.scope === 'ua') key = ua ? ua.slice(0, 150).toLowerCase() : null;
        else if (rule.scope === 'asn') key = asn !== null ? String(asn) : null;
        else key = 'global';
        if (!key) continue;

        if (hit(`${rule.id}|${key}`, rule.windowS * 1000) <= rule.maxHits) continue;

        // Excedida. Solo las reglas por IP clasifican la visita como bot;
        // el resto (UA, ASN, global) son avisos informativos.
        if (rule.scope === 'ip') {
          info.flags.push(`rule:${rule.name}`);
          ruleFlagged = true; // solo las reglas por IP marcan la visita como bot
        } else {
          (info.watch ??= []).push(`watch:${rule.name}`);
        }

        if (
          state.level >= 2 &&
          rule.action !== 'flag' &&
          ENFORCEABLE_SCOPES.includes(rule.scope) &&
          (!enforce || (rule.action === 'ban' && enforce.action !== 'ban'))
        ) {
          enforce = rule;
        }
      }

      if (enforce) {
        count('limited');
        waveTick();
        if (enforce.action === 'ban' && enforce.scope === 'ip' && ip) {
          const p = banSubject(db, state, ip, enforce.banMinutes, `Regla: ${enforce.name}`);
          if (waitUntil) waitUntil(p);
        }
        return { response: tooManyRequestsResponse(enforce.windowS), info };
      }
      if (ruleFlagged) count('flagged');
    }

    // Visita ya marcada por listas/reglas por IP → cuenta para la oleada.
    if (info.flags.length > 0) waveTick();

    return { info };
  } catch (e) {
    console.error('defense: error en defend(), la petición pasa:', e);
    return pass;
  }
}

/**
 * Auto-baneo de reincidentes. Se llama desde el scoring asíncrono de cada
 * visita (ya dentro de waitUntil). Cuenta visitas clasificadas como bot
 * (score ≥ 90) por IP —o /64 en IPv6— y, al llegar al umbral, crea una
 * entrada automática con caducidad.
 *
 * No cuenta: bots que se declaran (Googlebot, GPTBot…), buscadores
 * verificados por ASN, IPs de la lista blanca ni IPs ya listadas.
 */
export async function recordBotVisit(a: {
  db: any;
  ip: string | null;
  userAgent: string | null;
  asn: number | null;
  score: number;
  reasons: string[];
  /** Entorno (secrets de Telegram) para la alerta de oleada. */
  env?: any;
  /** La visita ya se contó en defend() (listas/reglas): no contarla dos veces para la oleada. */
  alreadyFlagged?: boolean;
}): Promise<void> {
  try {
    // Oleada de bots: cuenta todas las visitas clasificadas como bot (también las que se declaran).
    if (!a.alreadyFlagged && a.env) {
      const st = await getState(a.db);
      if (st?.enabled && st.alerts.enabled) {
        const n = botWave(st);
        if (n !== null) await sendAlert({ kind: 'wave', db: a.db, env: a.env, state: st, count: n });
      }
    }

    if (!a.ip || a.score < AUTOBAN_DEFAULTS.minScore) return;
    if (a.reasons.some((r) => r === 'known-bot' || r.startsWith('whitelisted'))) return;

    const parsed = parseIp(a.ip);
    if (!parsed) return;

    const state = await getState(a.db);
    if (!state || !state.enabled || !state.autoBan.enabled) return;
    if (isVerifiedSearchCrawler(a.userAgent, a.asn)) return;

    const subject = { ip: parsed, asn: a.asn };
    if (state.allows.size > 0 && findMatch(state.allows, subject)) return;
    if (state.blocks.size > 0 && findMatch(state.blocks, subject)) return;

    const now = Date.now();
    const key = subjectOf(parsed).value;
    const windowMs = state.autoBan.windowMin * 60_000;
    const times = (botHits.get(key) ?? []).filter((t) => now - t < windowMs);
    times.push(now);

    if (times.length >= state.autoBan.hits) {
      botHits.delete(key);
      await banSubject(
        a.db,
        state,
        parsed,
        state.autoBan.hours * 60,
        `Reincidente: ${state.autoBan.hits} visitas bot en ${state.autoBan.windowMin} min`
      );
    } else {
      if (botHits.size > 2000) botHits.clear();
      botHits.set(key, times);
    }
  } catch (e) {
    console.error('defense: error en recordBotVisit:', e);
  }
}
