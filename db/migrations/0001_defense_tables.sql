-- Defensa · Fase 1 — tablas nuevas (se puede ejecutar varias veces sin problema).
-- Ejecutar ANTES de desplegar el código:
--   npx wrangler d1 execute mi-blog-db --remote --file=db/migrations/0001_defense_tables.sql

-- IPs, rangos CIDR, ASN y países bloqueados (o marcados).
CREATE TABLE IF NOT EXISTS blocked_ips (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'ip',      -- ip | cidr | asn | country
  value      TEXT NOT NULL,
  reason     TEXT,
  source     TEXT DEFAULT 'manual',           -- manual | auto | telegram | honeypot
  created_at TEXT NOT NULL,
  expires_at TEXT,                            -- NULL = permanente (ISO 8601)
  hits       INTEGER DEFAULT 0,               -- reservado para la fase 2
  UNIQUE(kind, value)
);

-- Lista blanca: siempre gana a la lista negra y al mantenimiento.
CREATE TABLE IF NOT EXISTS allow_list (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'ip',
  value      TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(kind, value)
);

-- Reglas «X visitas cada Y tiempo» (se usarán en la fase 2).
CREATE TABLE IF NOT EXISTS defense_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  enabled      INTEGER DEFAULT 1,
  scope        TEXT NOT NULL,                 -- ip | ip_ua | asn | global
  path_pattern TEXT DEFAULT '/blog/*',
  max_hits     INTEGER NOT NULL,
  window_s     INTEGER NOT NULL,
  action       TEXT NOT NULL DEFAULT 'flag',  -- flag | limit | ban
  ban_minutes  INTEGER DEFAULT 15
);

-- Auditoría: solo eventos de bajo volumen (cambios de nivel, altas/bajas, etc.).
CREATE TABLE IF NOT EXISTS defense_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  type   TEXT NOT NULL,
  ip     TEXT,
  detail TEXT
);

-- Contadores agregados por hora (no una fila por petición bloqueada).
CREATE TABLE IF NOT EXISTS defense_hourly (
  hour    TEXT PRIMARY KEY,                   -- 2026-10-18T14
  flagged INTEGER DEFAULT 0,
  limited INTEGER DEFAULT 0,
  blocked INTEGER DEFAULT 0,
  maint   INTEGER DEFAULT 0
);

-- Para las consultas del panel (top IPs de las últimas 24 h).
CREATE INDEX IF NOT EXISTS idx_page_views_time ON page_views(viewed_at);

-- Ajustes iniciales (INSERT OR IGNORE: no pisa valores existentes).
INSERT OR IGNORE INTO settings (key, value) VALUES ('defense_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('defense_level', '0');
