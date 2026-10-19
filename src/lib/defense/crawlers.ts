// src/lib/defense/crawlers.ts
// ─────────────────────────────────────────────────────────────────────────────
// Buscadores legítimos verificados por ASN (el UA solo no basta: se falsifica).
// Se usan para NO aplicar reglas de frecuencia ni auto-baneo y evitar cortar a
// Google o Bing por error (perjudicaría al SEO).
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_UA = /googlebot|google-inspectiontool|bingbot|applebot/i;

/** ASN de Google, Microsoft (Bing) y Apple. */
const SEARCH_ASNS = new Set([15169, 8075, 714, 6185]);

export function isVerifiedSearchCrawler(userAgent: string | null | undefined, asn: number | null | undefined): boolean {
  return !!userAgent && typeof asn === 'number' && SEARCH_ASNS.has(asn) && SEARCH_UA.test(userAgent);
}
