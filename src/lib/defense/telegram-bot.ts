// src/lib/defense/telegram-bot.ts
// ─────────────────────────────────────────────────────────────────────────────
// Lógica del bot: pulsaciones de botones y el comando /estado. La ruta
// /api/telegram/webhook solo autentica la petición y delega aquí.
// ─────────────────────────────────────────────────────────────────────────────
import { LEVELS, type DefenseLevel } from './config';
import { applyBan, applyLevel, applyMaintenance, currentLevel } from './actions';
import { actionKeyboard, levelLine } from './alerts';
import { parseIp } from './ip';
import { answerCallback, esc, sendMessage, setKeyboard, type TgEnv } from './telegram-api';

type DB = any;

/**
 * Autorización: el chat debe ser TELEGRAM_CHAT_ID. Si es un chat privado
 * (id positivo), además quien pulsa debe ser ese mismo usuario. Si fuera un
 * grupo (id negativo), cualquier miembro podría pulsar: usa un chat privado.
 */
function authorized(env: TgEnv, chat: any, from: any): boolean {
  const chatId = String(env.TELEGRAM_CHAT_ID ?? '');
  if (!chatId || String(chat?.id ?? '') !== chatId) return false;
  return chatId.startsWith('-') || String(from?.id ?? '') === chatId;
}

export async function handleUpdate(update: any, env: TgEnv, db: DB): Promise<void> {
  if (update?.callback_query) {
    await handleCallback(update.callback_query, env, db);
  } else if (typeof update?.message?.text === 'string') {
    const m = update.message;
    if (!authorized(env, m.chat, m.from)) return; // se ignora en silencio
    if (/^\/(estado|status|start)\b/i.test(m.text)) await sendStatus(env, db);
  }
}

async function handleCallback(cb: any, env: TgEnv, db: DB): Promise<void> {
  if (!authorized(env, cb.message?.chat, cb.from)) {
    await answerCallback(env, String(cb.id), 'No autorizado', true);
    return;
  }

  const data = String(cb.data ?? '').slice(0, 64);
  const msgId: number | undefined = cb.message?.message_id;
  const who = `telegram:${cb.from?.id}`;
  const done = async (toast: string, followUp?: string, followKeyboard?: ReturnType<typeof actionKeyboard>) => {
    await answerCallback(env, String(cb.id), toast);
    if (msgId) await setKeyboard(env, msgId, null);
    if (followUp) await sendMessage(env, followUp, followKeyboard);
  };

  if (data === 'ign') {
    await done('Ignorado');
    return;
  }

  let m: RegExpMatchArray | null;

  if ((m = data.match(/^lvl:([0-2])$/))) {
    const level = Number(m[1]) as DefenseLevel;
    await applyLevel(db, level, who, 'telegram');
    await done(`Nivel ${level}`, `✅ Nivel cambiado a <b>${level} · ${esc(LEVELS[level].name)}</b>.\n${esc(LEVELS[level].description)}`);
    return;
  }

  if (data === 'mnt:on') {
    // Doble confirmación: un toque accidental no debe tirar el sitio.
    await answerCallback(env, String(cb.id), '¿Seguro?');
    if (msgId) {
      await setKeyboard(env, msgId, [[
        { text: '✅ Sí, activar mantenimiento', callback_data: 'mnt:yes' },
        { text: 'Cancelar', callback_data: 'ign' },
      ]]);
    }
    return;
  }

  if (data === 'mnt:yes') {
    await applyMaintenance(db, true, {}, who, 'telegram');
    await done('Mantenimiento activado', '🔧 <b>Mantenimiento ACTIVADO.</b> Todo el sitio público responde 503. El panel sigue accesible.', actionKeyboard(3));
    return;
  }

  if (data === 'mnt:off') {
    const level = await applyMaintenance(db, false, {}, who, 'telegram');
    await done('Mantenimiento desactivado', `✅ <b>Mantenimiento desactivado.</b> Nivel ${level} · ${esc(LEVELS[level].name)}.`);
    return;
  }

  if ((m = data.match(/^ban:(.{2,45})$/))) {
    const ip = parseIp(m[1]);
    if (!ip) {
      await answerCallback(env, String(cb.id), 'IP no válida', true);
      return;
    }
    const res = await applyBan(db, ip.text, 1440, 'Desde alerta de Telegram', who, 'telegram');
    const level = await currentLevel(db);
    const note =
      level >= 2
        ? 'Ya está activa (nivel Defensa).'
        : `Con el nivel ${level} solo se <b>marca</b>; para bloquearla de verdad sube a Defensa.`;
    await done(
      'IP añadida a la lista',
      `🚫 Añadida a la lista de bloqueo 24 h: <code>${esc(res!.value)}</code>\n${note}`,
      level < 2 ? [[{ text: '🛡 Subir a Defensa', callback_data: 'lvl:2' }, { text: 'Ignorar', callback_data: 'ign' }]] : undefined
    );
    return;
  }

  await answerCallback(env, String(cb.id), 'Acción desconocida');
}

async function sendStatus(env: TgEnv, db: DB): Promise<void> {
  const level = await currentLevel(db);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 13);
  const sums: any = await db
    .prepare(
      `SELECT COALESCE(SUM(flagged),0) AS f, COALESCE(SUM(blocked + limited),0) AS b, COALESCE(SUM(maint),0) AS m
       FROM defense_hourly WHERE hour >= ?`
    )
    .bind(since)
    .first()
    .catch(() => null);
  const blocks: any = await db
    .prepare(`SELECT COUNT(*) AS n FROM blocked_ips WHERE expires_at IS NULL OR expires_at > ?`)
    .bind(new Date().toISOString())
    .first()
    .catch(() => null);

  const text = [
    '📊 <b>Estado de la defensa</b>',
    '─────────────────',
    levelLine(level),
    `📋 Entradas de bloqueo vigentes: ${blocks?.n ?? 0}`,
    `Últimas 24 h → marcadas: ${sums?.f ?? 0} · bloqueadas: ${sums?.b ?? 0} · en mantenimiento: ${sums?.m ?? 0}`,
  ].join('\n');
  await sendMessage(env, text, actionKeyboard(level));
}
