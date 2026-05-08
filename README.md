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
| Despliegue | [Cloudflare Pages](https://pages.cloudflare.com) |
| Adapter | `@astrojs/cloudflare` |
| Markdown | `marked` + `sanitize-html` |
| Analytics | Google Analytics 4 |
| Tipado | TypeScript |

---

## Funcionalidades

### Blog público
- Listado de posts con paginación (10 por página)
- Búsqueda full-text con FTS5 y relevancia BM25
- Post individual con renderizado de Markdown sanitizado
- Sistema de comentarios con moderación previa y rate limiting
- Contador de visitas (IP, país, región, ciudad, user-agent)
- Botones de compartir en X, WhatsApp y Email
- View Transitions entre páginas para navegación fluida
- RSS feed en `/rss.xml`
- Sitemap dinámico en `/sitemap.xml` con `lastmod`

### Home
- Grid de 6 tarjetas premium con el post más reciente destacado en 2 columnas
- Animación de entrada escalonada
- Hover con elevación y sombra índigo
- Transición animada de imagen desde la lista al post

### SEO
- Meta tags completos (title, description, canonical)
- Open Graph y Twitter Card por página incluyendo `og:image:alt`
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
│   │   ├── Header.astro     # Navegación sticky con backdrop blur
│   │   └── Footer.astro
│   │
│   ├── layouts/
│   │   └── Base.astro       # Layout principal: SEO, OG, JSON-LD, GA4, ViewTransitions
│   │
│   ├── middleware.ts         # JWT auth + cabeceras de seguridad en todas las respuestas
│   │
│   ├── pages/
│   │   ├── index.astro      # Home con grid de 6 tarjetas premium
│   │   │
│   │   ├── blog/
│   │   │   ├── index.astro  # Listado con búsqueda FTS5 y paginación
│   │   │   └── [slug].astro # Post + comentarios + visitas + compartir
│   │   │
│   │   ├── panel/           # Panel de administración (protegido por JWT)
│   │   │   ├── index.astro  # Lista de posts con ordenación + exportar
│   │   │   ├── login.astro  # Página de login
│   │   │   ├── nuevo.astro  # Crear post (Toast UI Editor)
│   │   │   ├── comentarios.astro
│   │   │   ├── stats.astro  # Estadísticas de visitas
│   │   │   ├── editar/
│   │   │   │   └── [slug].astro
│   │   │   └── preview/
│   │   │       └── [slug].astro
│   │   │
│   │   ├── api/
│   │   │   ├── comments.ts          # POST — enviar comentario (público, con rate limiting)
│   │   │   └── panel/
│   │   │       ├── auth.ts          # POST — login JWT
│   │   │       ├── logout.ts        # POST — cerrar sesión
│   │   │       ├── comments.ts      # POST/DELETE — moderar comentarios
│   │   │       ├── posts.ts         # DELETE — borrar post
│   │   │       └── export.ts        # GET — exportar tablas a JSON
│   │   │
│   │   ├── rss.xml.ts       # RSS feed dinámico
│   │   └── sitemap.xml.ts   # Sitemap dinámico
│
├── patch-wrangler.mjs       # Limpia wrangler.json post-build para Pages
├── wrangler.toml            # Configuración Cloudflare (D1 binding)
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
  is_bot     INTEGER DEFAULT 0
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

### FTS5 — búsqueda full-text
```sql
CREATE VIRTUAL TABLE posts_fts USING fts5(
  slug UNINDEXED, title, description, content,
  content='posts', content_rowid='rowid'
);
```
Con triggers de sincronización automática en INSERT, UPDATE y DELETE sobre `posts`.

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
- Cuenta en Cloudflare con D1 configurado

### Variables de entorno
Configuradas en Cloudflare Pages como Secrets:

| Variable | Descripción |
|---|---|
| `ADMIN_USER` | Usuario del panel |
| `ADMIN_PASS` | Contraseña del panel |
| `JWT_SECRET` | Clave para firmar tokens JWT (mínimo 32 caracteres) |

---

## Despliegue

El proyecto se despliega automáticamente en Cloudflare Pages con cada push a `main`.

El script `patch-wrangler.mjs` corre como parte del build (`astro build && node patch-wrangler.mjs`) para limpiar el `wrangler.json` generado por el adapter y hacerlo compatible con Cloudflare Pages.

---

## Licencia

Uso personal. No se permite la reutilización del código sin permiso del autor.
