# Blog personal — Aitor Sánchez Gutiérrez

Blog personal con panel de administración propio, construido sobre Astro y desplegado en Cloudflare Pages. Sin CMS externo, sin base de datos gestionada por terceros — todo corre en infraestructura Cloudflare.

🌐 [aitorsanchez.pages.dev](https://aitorsanchez.pages.dev)

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Framework | [Astro 5](https://astro.build) — SSR modo servidor |
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) |
| Base de datos | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| Rate Limiting | [Cloudflare KV](https://developers.cloudflare.com/kv/) (contadores con TTL) |
| Despliegue | [Cloudflare Pages](https://pages.cloudflare.com) |
| Adapter | `@astrojs/cloudflare` |
| Markdown | `marked` + `sanitize-html` |
| Imágenes | Cloudinary (optimización y OG images dinámicas) |
| Analytics | Google Analytics 4 + analítica propia en D1 |
| Notificaciones | Telegram Bot API (visitas, comentarios, contacto) |
| Tipado | TypeScript |

---

## Funcionalidades

### Blog público
- Listado de posts con paginación (10 por página)
- Búsqueda full-text con FTS5 y relevancia BM25
- Post individual con renderizado de Markdown sanitizado
- Sistema de comentarios con moderación previa y rate limiting
- Contador de visitas con detección de bots por scoring en capas
- Botones de compartir en X, WhatsApp y Email
- View Transitions entre páginas para navegación fluida
- RSS feed en `/rss.xml`
- Sitemap dinámico en `/sitemap.xml` con `lastmod`
- Modo oscuro con detección automática y toggle manual
- Cabecera con efecto glassmorphism
- Scrollbar personalizada y color de selección adaptativo al tema
- Formulario de contacto con Cloudflare Turnstile

### Home
- Grid de 6 tarjetas premium con el post más reciente destacado en 2 columnas
- Animación de entrada escalonada
- Hover con elevación y sombra índigo
- Transición animada de imagen desde la lista al post

### SEO
- Meta tags completos (title, description, canonical)
- Open Graph y Twitter Card por página incluyendo `og:image:alt`
- OG images dinámicas generadas con Cloudinary
- JSON-LD Schema.org (`BlogPosting`, `BreadcrumbList`, `Person`)
- Foto del autor en JSON-LD para Knowledge Panel de Google
- `robots.txt` con bloqueo del panel
- Google Search Console verificado
- RSS autodescubrimiento en `<head>`
- Google Analytics 4 con pageview tracking en View Transitions

### Seguridad
- Autenticación JWT con página de login propia (`/panel/login`)
- Sesiones de 8 horas con expiración automática
- Rate limiting en login (5 intentos por IP cada 15 minutos)
- Cabeceras de seguridad vía middleware: HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- CSP diferenciada entre blog público y panel de administración
- Sanitización XSS con `sanitize-html` en renderizado de Markdown
- Honeypot para detección de crawlers
- Cloudflare Turnstile en formulario de contacto

### Notificaciones Telegram
Notificaciones en tiempo real vía Telegram Bot API para:
- **Visitas humanas** — solo se envían si la detección de bots determina `is_bot = 0` (tras scoring completo)
- **Comentarios nuevos** — con preview del contenido, datos del autor y ubicación
- **Mensajes de contacto** — nombre, email, asunto y preview del mensaje
- **Control:** activable/desactivable desde la tabla `settings` en D1 (`telegram_enabled`)

### Panel de administración (`/panel`)
Protegido por JWT. Botón de cerrar sesión incluido.

- **Posts** — crear, editar, borrar, marcar como borrador, previsualizar, ordenar por título/fecha/estado
- **Comentarios** — lista de pendientes con aprobar/rechazar/borrar, badge de pendientes en el panel
- **Estadísticas** — visitas por post, por país, por día (7 días) y por mes (12 meses), últimas visitas
- **Exportar** — descarga de posts, comentarios o visitas en JSON
- Iconos SVG inline en todos los botones del panel

### Privacidad
- Banner informativo sobre uso de Google Analytics y registro de datos
- Sin cookies de publicidad
- IPs registradas con fines de seguridad y estadística

---

## Detección de bots

El blog implementa un sistema de **scoring en capas** para clasificar visitas como humanas o bots. No bloquea ninguna petición — solo clasifica para mantener las estadísticas y las notificaciones de Telegram limpias.

### Arquitectura

Cada visita acumula un `bot_score` (0–100). Si supera el umbral de **50**, se marca como `is_bot = 1` y no se envía notificación a Telegram.

```
┌─────────────────────────────────────┐
│  Capa 1: Headers HTTP               │  +10 a +80
│  (sin UA, sin Accept-Language, etc.) │
├─────────────────────────────────────┤
│  Capa 1B: Cloudflare Bot Management │  +40
│  (score < 30 → probablemente bot)   │
├─────────────────────────────────────┤
│  Capa 2A: Bots conocidos            │  +90
│  (Googlebot, Bingbot, GPTBot, etc.) │
├─────────────────────────────────────┤
│  Capa 2B: Scrapers / escáneres      │  +60
│  (curl, wget, OpenVAS, Selenium...) │
├─────────────────────────────────────┤
│  Capa 3: Rate limiting (KV → D1)    │  +25 a +50
│  (≥8 páginas en 60s por IP)         │
├─────────────────────────────────────┤
│  Capa 4: Honeypot                   │  +100
│  (enlace invisible en el Footer)    │
└─────────────────────────────────────┘
```

### Flujo de ejecución

1. **Detección rápida (síncrona):** La visita se registra inmediatamente en `page_views` con una comprobación rápida por User-Agent.
2. **Scoring completo (asíncrono vía `waitUntil`):** El módulo `bot-detector.ts` ejecuta las 4 capas sin bloquear la respuesta al usuario.
3. **Actualización:** El registro se actualiza con el `bot_score` y el `is_bot` definitivo.
4. **Telegram:** Solo se envía notificación si el scoring final determina que es una visita humana.

### Rate Limiting con Cloudflare KV

La Capa 3 usa **Cloudflare KV** (binding `RATE_LIMIT`) con `expirationTtl: 60` segundos:
- Cada visita incrementa un contador con clave `rl:<ip>`
- El contador expira automáticamente tras 60 segundos
- No requiere consultas a D1 ni índices adicionales
- Si KV no está disponible, hace fallback automático a D1

### Archivos implicados

| Archivo | Responsabilidad |
|---|---|
| `src/lib/bot-detector.ts` | Módulo centralizado de scoring con todas las capas |
| `src/lib/telegram.ts` | Notificaciones a Telegram (visitas, comentarios, contacto) |
| `src/pages/blog/[slug].astro` | Invoca el detector y envía Telegram si es humano |
| `src/pages/trap.ts` | Endpoint honeypot (devuelve 404, registra IP en `bot_ips`) |
| `src/components/Footer.astro` | Contiene el enlace invisible que apunta a `/trap` |

### Bots cubiertos

- **Buscadores:** Googlebot, Google-InspectionTool, Bingbot, Slurp, DuckDuckBot, Baiduspider, Yandex, Sogou, Applebot
- **Redes sociales:** Facebook, Twitter, LinkedIn, WhatsApp, Telegram
- **SEO/Marketing:** Semrush, Ahrefs, MJ12bot, Dotbot, Rogerbot, Screaming Frog, Petalbot
- **IA/LLMs:** GPTBot, ChatGPT-User, Claude-Web, Anthropic-AI, Cohere-AI, PerplexityBot, Bytespider, Meta-ExternalAgent
- **Scrapers:** curl, wget, python-requests, aiohttp, Scrapy, go-http-client, node-fetch, Axios, Selenium, Puppeteer, Playwright
- **Escáneres:** OpenVAS
- **Google Ads:** Mediapartners-Google, AdsBot-Google

### SQL de migración

```sql
-- Añadir columna bot_score a page_views
ALTER TABLE page_views ADD COLUMN bot_score INTEGER DEFAULT 0;

-- Tabla de IPs atrapadas por el honeypot
CREATE TABLE IF NOT EXISTS bot_ips (
  ip TEXT PRIMARY KEY,
  detected_at TEXT NOT NULL,
  method TEXT DEFAULT 'honeypot'
);

-- Índice para optimizar el rate limiting (fallback D1)
CREATE INDEX IF NOT EXISTS idx_page_views_ip_time ON page_views(ip, viewed_at);
```

### Configuración de KV

```bash
# Crear el namespace de KV
npx wrangler kv namespace create RATE_LIMIT

# Copiar el ID generado al wrangler.toml
```

---

## Estructura del proyecto

```
/
├── public/
│   ├── images/              # Imágenes estáticas
│   ├── _headers             # Cabeceras HTTP (cache-control del panel)
│   ├── _redirects
│   ├── robots.txt
│   └── favicon.svg
│
├── src/
│   ├── components/
│   │   ├── Header.astro     # Navegación sticky con glassmorphism + toggle modo oscuro
│   │   └── Footer.astro     # Footer con honeypot invisible
│   │
│   ├── layouts/
│   │   └── Base.astro       # Layout principal: SEO, OG, JSON-LD, GA4, dark mode
│   │
│   ├── lib/
│   │   ├── bot-detector.ts  # Sistema de detección de bots por scoring en capas (KV + D1)
│   │   ├── images.ts        # Utilidades de optimización de imágenes (Cloudinary)
│   │   └── telegram.ts      # Notificaciones Telegram (visitas, comentarios, contacto)
│   │
│   ├── middleware.ts         # JWT auth + cabeceras de seguridad en todas las respuestas
│   │
│   ├── pages/
│   │   ├── index.astro      # Home con grid de 6 tarjetas premium
│   │   ├── trap.ts          # Endpoint honeypot para detectar crawlers
│   │   ├── contacto.astro   # Formulario de contacto con Turnstile
│   │   ├── 404.astro        # Página de error personalizada
│   │   │
│   │   ├── blog/
│   │   │   ├── index.astro  # Listado con búsqueda FTS5 y paginación
│   │   │   └── [slug].astro # Post + comentarios + bot scoring + Telegram
│   │   │
│   │   ├── panel/           # Panel de administración (protegido por JWT)
│   │   │   ├── index.astro  # Lista de posts con ordenación + exportar
│   │   │   ├── login.astro  # Página de login
│   │   │   ├── nuevo.astro  # Crear post (Toast UI Editor)
│   │   │   ├── comentarios.astro
│   │   │   ├── stats.astro  # Estadísticas de visitas
│   │   │   ├── visitas.astro
│   │   │   ├── editar/
│   │   │   │   └── [slug].astro
│   │   │   └── preview/
│   │   │       └── [slug].astro
│   │   │
│   │   ├── api/
│   │   │   ├── comments.ts          # POST — enviar comentario (público, con rate limiting)
│   │   │   ├── contacto.ts          # POST — formulario de contacto + Telegram + Turnstile
│   │   │   └── panel/
│   │   │       ├── auth.ts          # POST — login JWT
│   │   │       ├── logout.ts        # POST — cerrar sesión
│   │   │       ├── comments.ts      # POST/DELETE — moderar comentarios
│   │   │       ├── posts.ts         # DELETE — borrar post
│   │   │       └── export.ts        # GET — exportar tablas a JSON
│   │   │
│   │   ├── rss.xml.ts       # RSS feed dinámico
│   │   ├── sitemap.xml.ts   # Sitemap dinámico
│   │   └── privacidad.astro
│
├── patch-wrangler.mjs       # Limpia wrangler.json post-build para Pages
├── wrangler.toml            # Configuración Cloudflare (D1 + KV bindings)
├── astro.config.mjs
└── package.json
```

---

## Base de datos — Cloudflare D1

### `posts`
```sql
CREATE TABLE posts (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  content     TEXT,
  pub_date    TEXT NOT NULL,
  hero_image  TEXT,
  draft       INTEGER DEFAULT 0
);
```

### `comments`
```sql
CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  autor      TEXT NOT NULL,
  email      TEXT,
  contenido  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  estado     TEXT DEFAULT 'pendiente',
  ip         TEXT
);
```

### `page_views`
```sql
CREATE TABLE page_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  viewed_at  TEXT NOT NULL,
  ip         TEXT,
  country    TEXT,
  region     TEXT,
  city       TEXT,
  user_agent TEXT,
  referer    TEXT,
  is_bot     INTEGER DEFAULT 0,
  bot_score  INTEGER DEFAULT 0
);
```

### `bot_ips`
```sql
CREATE TABLE bot_ips (
  ip          TEXT PRIMARY KEY,
  detected_at TEXT NOT NULL,
  method      TEXT DEFAULT 'honeypot'
);
```

### `login_attempts`
```sql
CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  created_at TEXT NOT NULL,
  success    INTEGER DEFAULT 0
);
```

### `settings`
```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Control de notificaciones Telegram:
-- INSERT INTO settings VALUES ('telegram_enabled', '1');
```

### FTS5 — búsqueda full-text
```sql
CREATE VIRTUAL TABLE posts_fts USING fts5(
  slug UNINDEXED, title, description, content,
  content='posts', content_rowid='rowid'
);
```
Con triggers de sincronización automática en INSERT, UPDATE y DELETE sobre `posts`.

### Índices
```sql
CREATE INDEX IF NOT EXISTS idx_page_views_ip_time ON page_views(ip, viewed_at);
```

---

## Desarrollo local

```bash
npm install
npm run dev       # Puerto 3000
npm run build
npm run preview
```

### Requisitos
- Node.js >= 22.16.0
- Cuenta en Cloudflare con D1 y KV configurados

### Variables de entorno
Configuradas en Cloudflare Pages como Secrets:

| Variable | Descripción |
|---|---|
| `ADMIN_USER` | Usuario del panel |
| `ADMIN_PASS` | Contraseña del panel |
| `JWT_SECRET` | Clave para firmar tokens JWT (mínimo 32 caracteres) |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram |
| `TELEGRAM_CHAT_ID` | ID del chat de destino para notificaciones |
| `TURNSTILE_SECRET` | Clave secreta de Cloudflare Turnstile |

---

## Despliegue

El proyecto se despliega automáticamente en Cloudflare Pages con cada push a `main`.

El script `patch-wrangler.mjs` corre como parte del build (`astro build && node patch-wrangler.mjs`) para limpiar el `wrangler.json` generado por el adapter y hacerlo compatible con Cloudflare Pages.

---

## Licencia

Uso personal. No se permite la reutilización del código sin permiso del autor.
