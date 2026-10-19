-- Defensa · Fase 2 — reglas de frecuencia por defecto (solo si la tabla está vacía).
-- Se puede ejecutar varias veces sin duplicar reglas:
--   npx wrangler d1 execute mi-blog-db --remote --file=db/migrations/0003_defense_rules_seed.sql
--
-- Hasta que subas el nivel a 2, estas reglas solo MARCAN; no bloquean nada.
-- Los ámbitos 'ua' y 'global' nunca bloquean (solo avisan), aunque pongas otra acción.
INSERT INTO defense_rules (name, enabled, scope, path_pattern, max_hits, window_s, action, ban_minutes)
SELECT * FROM (
  SELECT 'Ráfaga por IP',                 1, 'ip',     '/blog/*', 30,  60, 'ban',  15
  UNION ALL
  SELECT 'Mismo UA desde muchas IPs',     1, 'ua',     '*',       20,  60, 'flag', 15
  UNION ALL
  SELECT 'Presión global',                1, 'global', '*',       300, 60, 'flag', 15
)
WHERE NOT EXISTS (SELECT 1 FROM defense_rules);

INSERT OR IGNORE INTO settings (key, value) VALUES ('defense_auto_ban', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('defense_lite_skip_logging', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('defense_auto_purge', '0');
