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
  cf?: any;                 // Cloudflare context object (request.cf)
  path?: string;            // The request URL pathname
}

// ── Umbral ──────────────────────────────────────────────────────────────────
const BOT_THRESHOLD = 50;

// ── Listas Blancas (Exclusiones) ────────────────────────────────────────────
const WHITELISTED_PATHS = /^\/api\/contacto|^\/api\/webhooks|^\/api\/stripe/i;
const WHITELISTED_UA = /stripe\/|vercel|supabase|uptime|kuma|statuscake|pingdom/i;
const WHITELISTED_ASNS = new Set([13335]); // AS13335 = Cloudflare

// ── Detección de Datacenters / Hosting ──────────────────────────────────────
const HOSTING_ORGS = /amazon|aws|google\s+cloud|google\s+llc|microsoft\s+corporation|azure|hetzner|ovh|digitalocean|linode|leaseweb|contabo|scaleway|oracle|choopa|vultr|colocrossing|m247|limestone|hostinger|datacenter|hosting|cloud\s+vps|server/i;

// ── Capa 2A: Bots conocidos que se auto-identifican (score +90) ─────────────
const KNOWN_BOTS = /googlebot|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|applebot|mediapartners-google|adsbot-google|petalbot|bytespider|gptbot|chatgpt-user|claudebot|claude-web|anthropic-ai|cohere-ai|perplexitybot|meta-externalagent|ia_archiver|semrush|ahrefs|mj12bot|dotbot|rogerbot|screaming\.frog/i;

// ── Capa 2B: Herramientas de scraping / escáneres de seguridad (score +60) ──
const SCRAPER_UA = /curl|wget|python-requests|python-urllib|aiohttp|scrapy|go-http-client|node-fetch|axios|java\/|libwww-perl|php\/|ruby|mechanize|httpclient|okhttp|headless|phantomjs|selenium|puppeteer|playwright|openvas/i;

// ── Rate Limiting con KV ────────────────────────────────────────────────────
// Clave ventana 60s : "rl:<ip>",                        TTL: 60s
// Clave ráfaga 1s   : "rl:burst:<ip>:<epoch_segundos>", TTL: 10s
const RATE_KEY_PREFIX   = 'rl:';
const RATE_BURST_PREFIX = 'rl:burst:';
const RATE_WINDOW_TTL   = 60;  // segundos
const RATE_BURST_TTL    = 10;  // segundos

/**
 * Incrementa los contadores de visitas de una IP en KV.
 * Devuelve { count: visitas en 60s, burst: visitas en el segundo actual }.
 * Si KV no está disponible, hace fallback a D1.
 */
async function getRateCount(
  ip: string,
  kv: KVNamespace | undefined,
  db: any
): Promise<{ count: number; burst: number }> {
  if (kv) {
    try {
      const key      = `${RATE_KEY_PREFIX}${ip}`;
      const burstKey = `${RATE_BURST_PREFIX}${ip}:${Math.floor(Date.now() / 1000)}`;

      const [current, currentBurst] = await Promise.all([
        kv.get(key).then(v => parseInt(v ?? '0', 10)),
        kv.get(burstKey).then(v => parseInt(v ?? '0', 10)),
      ]);

      const next      = current + 1;
      const nextBurst = currentBurst + 1;

      await Promise.all([
        kv.put(key,      String(next),      { expirationTtl: RATE_WINDOW_TTL }),
        kv.put(burstKey, String(nextBurst), { expirationTtl: RATE_BURST_TTL  }),
      ]);

      return { count: next, burst: nextBurst };
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
      return { count: (recent as any)?.n ?? 0, burst: 0 };
    } catch {
      // Ignorar errores de BD
    }
  }

  return { count: 0, burst: 0 };
}

/**
 * Cuenta cuántos User-Agents distintos ha usado esta IP en los últimos 60s.
 * Solo consultable en D1 (KV no almacena UAs).
 */
async function getDistinctUACount(ip: string, db: any): Promise<number> {
  if (!db) return 0;
  try {
    const result = await db.prepare(
      `SELECT COUNT(DISTINCT user_agent) as n FROM page_views
       WHERE ip = ? AND viewed_at >= datetime('now', '-60 seconds')`
    ).bind(ip).first();
    return (result as any)?.n ?? 0;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
export async function detectBot(input: DetectionInput): Promise<BotDetectionResult> {
  let score = 0;
  const reasons: string[] = [];
  const { userAgent, headers, ip, db, kv, cfBotScore, cf, path } = input;

  // ── Capa 0: Exclusiones Previas (Whitelist) ─────────────────────────────
  // 1. Exclusión por Ruta Crítica
  if (path && WHITELISTED_PATHS.test(path)) {
    return { score: 0, isBot: false, reasons: ['whitelisted-path'] };
  }

  // 2. Exclusión por User-Agent de confianza
  if (userAgent && WHITELISTED_UA.test(userAgent)) {
    return { score: 0, isBot: false, reasons: ['whitelisted-ua'] };
  }

  // 3. Exclusión por ASN de confianza
  if (cf?.asn && WHITELISTED_ASNS.has(cf.asn)) {
    return { score: 0, isBot: false, reasons: ['whitelisted-asn'] };
  }

  // ── Capa 1: Headers HTTP ────────────────────────────────────────────────
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

  if (headers.get('sec-fetch-mode') === 'navigate') {
    score -= 20;
    reasons.push('sec-fetch-ok');
  }

  // ── Capa 1B: Cloudflare Bot Management (si disponible) ──────────────────
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
      const { count, burst } = await getRateCount(ip, kv, db);

      // Ráfaga en el mismo segundo — imposible para un humano
      if (burst >= 3) {
        score += 70;
        reasons.push(`burst-${burst}/1s`);
      } else if (burst >= 2) {
        score += 35;
        reasons.push(`burst-${burst}/1s`);
      }

      // Ventana de 60s
      if (count >= 15) {
        score += 50;
        reasons.push(`rate-${count}/60s`);
      } else if (count >= 8) {
        score += 25;
        reasons.push(`rate-${count}/60s`);
      }
    } catch {
      // No penalizar si falla
    }

    // ── Capa 3B: User-Agents distintos en 60s ─────────────────────────────
    // Un humano no cambia de navegador entre visitas. Varios UAs = bot rotador.
    try {
      const distinctUAs = await getDistinctUACount(ip, db);
      if (distinctUAs >= 3) {
        score += 60;
        reasons.push(`multi-ua:${distinctUAs}`);
      } else if (distinctUAs === 2) {
        score += 20;
        reasons.push(`multi-ua:2`);
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

  // ── Capa 5: Datacenter & Browser Spoofing ───────────────────────────────
  if (cf?.asOrganization) {
    const isDatacenter = HOSTING_ORGS.test(cf.asOrganization);
    const isKnownCrawlerOrScraper = userAgent && (KNOWN_BOTS.test(userAgent) || SCRAPER_UA.test(userAgent));
    const claimsToBeBrowser = userAgent && /mozilla|chrome|safari|firefox|edge|opera|mobile/i.test(userAgent) && !isKnownCrawlerOrScraper;
    const isVerifiedBot = cf?.botManagement?.verifiedBot === true;

    if (isDatacenter && claimsToBeBrowser && !isVerifiedBot) {
      score += 40;
      reasons.push('browser-spoofing');

      // Latencia ultrabaja en datacenter (clientTcpRtt < 10ms)
      if (typeof cf.clientTcpRtt === 'number' && cf.clientTcpRtt >= 0 && cf.clientTcpRtt < 10) {
        score += 30;
        reasons.push('low-rtt-datacenter');
      }
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
