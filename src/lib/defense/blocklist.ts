// src/lib/defense/blocklist.ts
// ─────────────────────────────────────────────────────────────────────────────
// Listas compiladas en memoria: IPs exactas (Map, O(1)), rangos CIDR, ASN y
// países. Se construyen una vez por refresco de caché, no por petición.
// ─────────────────────────────────────────────────────────────────────────────
import type { EntryKind, ListEntry } from './config';
import { cidrContains, parseCidr, parseIp, type ParsedCidr, type ParsedIp } from './ip';

export interface CompiledList {
  exact: Map<string, ListEntry>;
  cidrs: Array<{ cidr: ParsedCidr; entry: ListEntry }>;
  asns: Map<number, ListEntry>;
  countries: Map<string, ListEntry>;
  size: number;
}

export function emptyList(): CompiledList {
  return { exact: new Map(), cidrs: [], asns: new Map(), countries: new Map(), size: 0 };
}

/** Normaliza y valida el valor de una entrada. Devuelve null si no es válido. */
export function normalizeValue(kind: EntryKind, raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  switch (kind) {
    case 'ip':
      return parseIp(v)?.text ?? null;
    case 'cidr':
      return parseCidr(v)?.text ?? null;
    case 'asn': {
      const m = /^(?:as)?(\d{1,10})$/i.exec(v);
      return m ? m[1] : null;
    }
    case 'country':
      return /^[a-z]{2}$/i.test(v) ? v.toUpperCase() : null;
    default:
      return null;
  }
}

export function addToList(list: CompiledList, entry: ListEntry): boolean {
  const norm = normalizeValue(entry.kind, entry.value);
  if (!norm) return false;
  const e: ListEntry = { ...entry, value: norm };
  switch (entry.kind) {
    case 'ip': {
      const ip = parseIp(norm)!;
      list.exact.set(ip.key, e);
      break;
    }
    case 'cidr':
      list.cidrs.push({ cidr: parseCidr(norm)!, entry: e });
      break;
    case 'asn':
      list.asns.set(Number(norm), e);
      break;
    case 'country':
      list.countries.set(norm, e);
      break;
  }
  list.size++;
  return true;
}

export interface Subject {
  ip: ParsedIp | null;
  asn?: number | null;
  country?: string | null;
}

/** Primera coincidencia: IP exacta → CIDR → ASN → país. */
export function findMatch(list: CompiledList, s: Subject): ListEntry | null {
  if (s.ip) {
    const hit = list.exact.get(s.ip.key);
    if (hit) return hit;
    for (const { cidr, entry } of list.cidrs) {
      if (cidrContains(cidr, s.ip)) return entry;
    }
  }
  if (typeof s.asn === 'number') {
    const hit = list.asns.get(s.asn);
    if (hit) return hit;
  }
  if (s.country) {
    const hit = list.countries.get(s.country.toUpperCase());
    if (hit) return hit;
  }
  return null;
}
