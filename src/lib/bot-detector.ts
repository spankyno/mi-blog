// src/lib/bot-detector.ts
// ─────────────────────────────────────────────────────────────────────────────
// Sistema de detección de bots por scoring (0–100).
// Diseñado para Cloudflare Workers + D1 + KV. No bloquea; solo clasifica.
// ─────────────────────────────────────────────────────────────────────────────

export interface BotDetectionResult {
  score: number;
  isBot: boolean;
  reasons: string[];
}

export interface DetectionInput {
  userAgent: string | null;
  headers: Headers;
  ip: string | null;
  db: any;                  // D1Database
  kv?: KVNamespace;         // Cloudflare KV "RATE_LIMIT" (opcional)
  cfBotScore?: number;      // Cloudflare Bot Management score (1 = bot, 99 = humano)
}

// ── Umbral ──────────────────────────────────────────────────────────────────
const BOT_THRESHOLD = 50;

// ── Capa 2A: Bots conocidos que se auto-identifican (score +90) ─────────────
const KNOWN_BOTS = /googlebot|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|applebot|mediapartners-google|adsbot-google|petalbot|bytespider|gptbot|chatgpt-user|claude-web|anthropic-ai|cohere-ai|perplexitybot|meta-externalagent|ia_archiver|semrush|ahrefs|mj12bot|dotbot|rogerbot|screaming\.frog/i;

// ── Capa 2B: Herramientas de scraping / escáneres de seguridad (score +60) ──
const SCRAPER_UA = /curl|wget|python-requests|python-urllib|aiohttp|scrapy|go-http-client|node-fetch|axios|java\/|libwww-perl|php\/|ruby|mechanize|httpclient|okhttp|headless|phantomjs|selenium|puppeteer|playwright|openvas/i;

// ── Rate Limiting con KV ────────────────────────────────────────────────────
// Clave: "rl:<ip>", Valor: número de visitas, TTL: 60s (auto-expira)
const RATE_KEY_PREFIX = 'rl:';
const RATE_WINDOW_TTL = 60; // segundos

/**
 * Incrementa el contador de visitas de una IP en KV.
 * Devuelve el número de visitas en la ventana actual (60s).
 * Si KV no está disponible, hace fallback a D1.
 */
async function getRateCount(
  ip: string,
  kv: KVNamespace | undefined,
  db: any
): Promise<number> {
  // Preferir KV (más rápido, auto-expira)
  if (kv) {
    try {
      const key = `${RATE_KEY_PREFIX}${ip}`;
      const current = parseInt(await kv.get(key) ?? '0', 10);
      const next = current + 1;
      await kv.put(key, String(next), { expirationTtl: RATE_WINDOW_TTL });
      return next;
    } catch {
      // Si KV falla, caer a D1
    }
  }

  // Fallback: D1
  if (db) {
    try {
      const recent = await db.prepare(
        `SELECT COUNT(*) as n FROM page_views
         WHERE ip = ? AND viewed_at >= datetime('now', '-60 seconds')`
      ).bind(ip).first();
      return (recent as any)?.n ?? 0;
    } catch {
      // Ignorar errores de BD
    }
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
export async function detectBot(input: DetectionInput): Promise<BotDetectionResult> {
  let score = 0;
  const reasons: string[] = [];
  const { userAgent, headers, ip, db, kv, cfBotScore } = input;

  // ── Capa 1: Headers HTTP ────────────────────────────────────────────────
  // Un navegador real siempre envía ciertos headers; un scraper a menudo no.

  if (!userAgent || userAgent.trim() === '') {
    score += 80;
    reasons.push('sin-ua');
  }

  if (!headers.get('accept-language')) {
    score += 15;
    reasons.push('sin-accept-language');
  }

  const accept = headers.get('accept') ?? '';
  if (!accept || accept === '*/*') {
    score += 10;
    reasons.push('accept-genérico');
  }

  // sec-fetch-mode: navigate es un indicador fuerte de navegador real
  if (headers.get('sec-fetch-mode') === 'navigate') {
    score -= 20;
    reasons.push('sec-fetch-ok');
  }

  // ── Capa 1B: Cloudflare Bot Management (si disponible) ──────────────────
  // cfBotScore: 1 = bot seguro, 99 = humano seguro
  if (typeof cfBotScore === 'number' && cfBotScore < 30) {
    score += 40;
    reasons.push(`cf-bot-score:${cfBotScore}`);
  }

  // ── Capa 2: User-Agent patterns ─────────────────────────────────────────
  if (userAgent) {
    if (KNOWN_BOTS.test(userAgent)) {
      score += 90;
      reasons.push('known-bot');
    } else if (SCRAPER_UA.test(userAgent)) {
      score += 60;
      reasons.push('scraper-ua');
    } else if (userAgent.length < 30 || /^Mozilla\/5\.0$/.test(userAgent.trim())) {
      score += 30;
      reasons.push('ua-sospechoso');
    }
  }

  // ── Capa 3: Rate limiting (KV → fallback D1) ───────────────────────────
  if (ip) {
    try {
      const count = await getRateCount(ip, kv, db);
      if (count >= 15) {
        score += 50;
        reasons.push('rate-15/60s');
      } else if (count >= 8) {
        score += 25;
        reasons.push('rate-8/60s');
      }
    } catch {
      // No penalizar si falla
    }
  }

  // ── Capa 4: Honeypot (solo con IP y DB) ─────────────────────────────────
  if (ip && db) {
    try {
      const trapped = await db.prepare(
        `SELECT 1 FROM bot_ips WHERE ip = ?`
      ).bind(ip).first();
      if (trapped) {
        score += 100;
        reasons.push('honeypot');
      }
    } catch {
      // Tabla puede no existir aún — silenciar
    }
  }

  // Clamp entre 0 y 100
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    isBot: score >= BOT_THRESHOLD,
    reasons,
  };
}
