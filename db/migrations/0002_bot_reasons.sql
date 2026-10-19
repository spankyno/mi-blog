-- Defensa · Fase 1 — motivo de cada clasificación como bot.
-- Ejecutar UNA SOLA VEZ (ALTER TABLE no es idempotente; si la columna ya existe dará error y no pasa nada):
--   npx wrangler d1 execute mi-blog-db --remote --file=db/migrations/0002_bot_reasons.sql
ALTER TABLE page_views ADD COLUMN bot_reasons TEXT;
