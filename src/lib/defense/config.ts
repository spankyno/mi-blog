// src/lib/defense/config.ts
// ─────────────────────────────────────────────────────────────────────────────
// Tipos, niveles y constantes del módulo de defensa.
// ─────────────────────────────────────────────────────────────────────────────

export type DefenseLevel = 0 | 1 | 2 | 3;

export const LEVELS: Record<DefenseLevel, { name: string; short: string; description: string }> = {
  0: {
    name: 'Normal',
    short: 'Solo marcar',
    description:
      'Comportamiento actual. Las IPs de las listas se marcan como bot en las estadísticas, pero nunca se bloquea nada.',
  },
  1: {
    name: 'Vigilancia',
    short: 'Marcar + ahorro de cuota',
    description:
      'Igual que Normal, pero las visitas de IPs listadas no consumen KV ni scoring completo. Nunca bloquea.',
  },
  2: {
    name: 'Defensa',
    short: 'Bloquear listas',
    description:
      'Las IPs, rangos, ASN y países de la lista de bloqueo reciben un 403. Las IPs del honeypot solo se marcan.',
  },
  3: {
    name: 'Mantenimiento',
    short: 'Página 503',
    description:
      'Todo el sitio público devuelve 503 con la página de mantenimiento. El panel sigue accesible.',
  },
};

/** Ajustes por defecto (si la fila no existe en `settings`). */
export const DEFAULTS = {
  enabled: true,
  level: 0 as DefenseLevel,
  maintenanceMessage:
    'Estamos realizando tareas de mantenimiento. Volveremos en breve.',
  maintenanceEta: null as string | null,
};

/** La caché en memoria de cada isolate se refresca como mucho cada 60 s. */
export const CACHE_TTL_MS = 60_000;

/** Límites de filas cargadas en memoria (protege memoria y lecturas de D1). */
export const MAX_BLOCK_ROWS = 5000;
export const MAX_ALLOW_ROWS = 1000;
export const MAX_HONEYPOT_ROWS = 2000;

/** Las IPs del honeypot se consideran «recientes» durante estos días. */
export const HONEYPOT_DAYS = 30;

/** Origen de una entrada. Las de `honeypot` solo marcan, nunca bloquean. */
export type EntrySource = 'manual' | 'auto' | 'telegram' | 'honeypot';
export type EntryKind = 'ip' | 'cidr' | 'asn' | 'country';

export interface ListEntry {
  id?: number;
  kind: EntryKind;
  value: string;
  source: EntrySource;
  reason?: string | null;
}

/** Lo que el middleware deja en `locals.defense` para el resto del sitio. */
export interface DefenseInfo {
  level: DefenseLevel;
  /**
   * Marcas que CLASIFICAN la visita como bot: 'blocklist:<origen>' o 'rule:<nombre>'.
   */
  flags: string[];
  /** Avisos informativos que NO marcan como bot (reglas por UA/ASN/global): 'watch:<nombre>'. */
  watch?: string[];
  /** Modo lite activo: las visitas ya marcadas no se registran en page_views. */
  lite?: boolean;
}

// ── Reglas de frecuencia («X visitas cada Y tiempo») ────────────────────────
export type RuleScope = 'ip' | 'ua' | 'asn' | 'global';
export type RuleAction = 'flag' | 'limit' | 'ban';

export interface Rule {
  id: number;
  name: string;
  scope: RuleScope;
  pathPattern: string;
  maxHits: number;
  windowS: number;
  action: RuleAction;
  banMinutes: number;
}

/** Solo estos ámbitos pueden bloquear; UA y global únicamente avisan (un UA común o el total no deben cortar a nadie). */
export const ENFORCEABLE_SCOPES: RuleScope[] = ['ip', 'asn'];

export const MAX_RULES = 50;

// ── Auto-baneo de reincidentes ──────────────────────────────────────────────
export const AUTOBAN_DEFAULTS = {
  enabled: true,
  hits: 5,        // visitas clasificadas como bot…
  windowMin: 10,  // …en esta ventana…
  hours: 24,      // …⇒ entrada automática de esta duración
  minScore: 90,
  maxAutoEntries: 500,
};

// ── Retención de datos ──────────────────────────────────────────────────────
export const RETENTION = {
  botViewsDays: 30,
  humanViewsDays: 395, // ~13 meses (las estadísticas muestran 12)
  botIpsDays: 30,
  eventsDays: 90,
  hourlyDays: 30,
  expiredBlocksDays: 7,
  maxRowsPerTable: 20_000, // protege la cuota de escrituras de D1 (100.000/día)
};

/** Rutas que el módulo nunca toca (siempre accesibles para poder deshacer cambios). */
export function isDefenseExempt(pathname: string): boolean {
  return (
    pathname === '/panel' ||
    pathname.startsWith('/panel/') ||
    pathname.startsWith('/api/panel/') ||
    pathname.startsWith('/api/telegram/') // webhook de Telegram (fase 3)
  );
}

// ── Alertas por Telegram ────────────────────────────────────────────────────
export const ALERT_DEFAULTS = {
  enabled: true,
  ipPerMin: 30,       // una IP (o /64) supera N visitas en 60 s
  wave5min: 40,       // N visitas de bots en 5 minutos
  cooldownMin: 30,    // mínimo entre alertas del mismo tipo
  autoEscalate: false, // si está en nivel 0, subir solo a nivel 1 (nunca bloquea)
  notifyChanges: true, // avisar de cambios de nivel/mantenimiento hechos desde el panel
  loginFails: 3,      // fallos de acceso al panel (misma IP, 15 min) que disparan un aviso; 0 = no avisar
};

// ── Detector de escáneres ───────────────────────────────────────────────────
export const SCANNER_DEFAULTS = {
  enabled: true,
  hours: 48, // duración del baneo automático de una IP que pide rutas de escáner
};
