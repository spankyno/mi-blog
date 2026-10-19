// src/lib/defense/ip.ts
// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de IP: parseo, normalización y coincidencia con CIDR (IPv4/IPv6).
// Sin dependencias; usa BigInt (disponible en Workers).
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedIp {
  family: 4 | 6;
  value: bigint;
  /** Clave canónica para búsquedas exactas, p. ej. "4:1.2.3.4" o "6:2001:db8::1". */
  key: string;
  /** Texto canónico (v6 comprimido en minúsculas). */
  text: string;
}

export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v;
}

export function parseIPv6(input: string): bigint | null {
  let s = input.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;

  // Cola IPv4 incrustada (::ffff:1.2.3.4)
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s =
      s.slice(0, lastColon + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ':' +
      (v4 & 0xffff).toString(16);
  }

  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];

  let groups: string[];
  if (parts.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
    if (groups.length !== 8) return null;
  }

  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

export function formatIPv6(v: bigint): string {
  const g: number[] = [];
  for (let i = 7; i >= 0; i--) g.push(Number((v >> BigInt(i * 16)) & 0xffffn));

  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (g[i] === 0) {
      if (curStart < 0) { curStart = i; curLen = 0; }
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  const hex = (x: number) => x.toString(16);
  if (bestLen < 2) return g.map(hex).join(':');
  return (
    g.slice(0, bestStart).map(hex).join(':') +
    '::' +
    g.slice(bestStart + bestLen).map(hex).join(':')
  );
}

function formatIPv4(v: number): string {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

export function parseIp(input: string | null | undefined): ParsedIp | null {
  if (!input) return null;
  const s = input.trim();
  if (s.includes(':')) {
    const v = parseIPv6(s);
    if (v === null) return null;
    const text = formatIPv6(v);
    return { family: 6, value: v, key: `6:${text}`, text };
  }
  const v4 = parseIPv4(s);
  if (v4 === null) return null;
  const text = formatIPv4(v4);
  return { family: 4, value: BigInt(v4), key: `4:${text}`, text };
}

export interface ParsedCidr {
  family: 4 | 6;
  base: bigint;
  mask: bigint;
  prefix: number;
  /** Texto canónico "red/prefijo". */
  text: string;
}

/**
 * Prefijos mínimos aceptados. Evita bloquear medio internet por error
 * (por ejemplo 0.0.0.0/0).
 */
const MIN_PREFIX_V4 = 8;
const MIN_PREFIX_V6 = 16;

export function parseCidr(input: string): ParsedCidr | null {
  const [addr, pfx, ...rest] = input.trim().split('/');
  if (rest.length || pfx === undefined || !/^\d{1,3}$/.test(pfx)) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const prefix = Number(pfx);
  const bits = ip.family === 4 ? 32 : 128;
  const min = ip.family === 4 ? MIN_PREFIX_V4 : MIN_PREFIX_V6;
  if (prefix < min || prefix > bits) return null;

  const all = (1n << BigInt(bits)) - 1n;
  const host = (1n << BigInt(bits - prefix)) - 1n;
  const mask = all ^ host;
  const base = ip.value & mask;
  const text =
    ip.family === 4
      ? `${formatIPv4(Number(base))}/${prefix}`
      : `${formatIPv6(base)}/${prefix}`;
  return { family: ip.family, base, mask, prefix, text };
}

export function cidrContains(c: ParsedCidr, ip: ParsedIp): boolean {
  return c.family === ip.family && (ip.value & c.mask) === c.base;
}

/** Devuelve "red/64" de una IPv6 (para bloquear el /64 completo del atacante). */
export function ipv6Slash64(ip: ParsedIp): string | null {
  if (ip.family !== 6) return null;
  const mask = ((1n << 128n) - 1n) ^ ((1n << 64n) - 1n);
  return `${formatIPv6(ip.value & mask)}/64`;
}
