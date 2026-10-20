-- Defensa · Revisión — índices para que el refresco de listas (cada ~60 s por servidor)
-- lea solo las filas vigentes y no recorra toda la tabla.
--
-- Sin estos índices, las consultas de refresco hacen SCAN de blocked_ips y bot_ips: su coste crece
-- con TODAS las filas históricas (incluidas las caducadas) y puede acercarse al límite diario de
-- lecturas de D1 (5 millones) si la poda no se ejecuta. Con ellos, el coste depende solo de las filas vigentes.
-- Se puede ejecutar varias veces sin problema:
--   npx wrangler d1 execute mi-blog-db --remote --file=db/migrations/0004_defense_indexes.sql
CREATE INDEX IF NOT EXISTS idx_blocked_expires ON blocked_ips(expires_at);
CREATE INDEX IF NOT EXISTS idx_bot_ips_detected ON bot_ips(detected_at);
