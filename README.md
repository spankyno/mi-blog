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
| Tipado | TypeScript |

---

## Funcionalidades

### Blog público
- Listado de posts con paginación (10 por página)
- Búsqueda full-text con FTS5 y relevancia BM25
- Post individual con renderizado de Markdown sanitizado
- Sistema de comentarios con moderación previa
- Contador de visitas (IP, país, región, ciudad, user-agent)
- RSS feed en `/rss.xml`
- Sitemap dinámico en `/sitemap.xml` con `lastmod`

### SEO
- Meta tags completos (title, description, canonical)
- Open Graph y Twitter Card por página
- JSON-LD Schema.org (`BlogPosting`, `BreadcrumbList`)
- `robots.txt` con bloqueo del panel
- Google Search Console verificado
- RSS autodescubrimiento en `<head>`

### Panel de administración (`/panel`)
Protegido por Basic Auth via middleware de Cloudflare Workers.

- **Posts** — crear, editar, borrar, marcar como borrador, previsualizar
- **Comentarios** — lista de pendientes con aprobar/rechazar/borrar
- **Estadísticas** — visitas por post, por país, por día, últimas visitas

### Privacidad
- Banner informativo sobre registro de datos de acceso
- Sin cookies de tracking ni publicidad
- IPs registradas con fines de seguridad y estadística

---

## Estructura del proyecto

```
/
├── public/
│   ├── images/              # Imágenes estáticas
│   ├── _headers             # Cabeceras HTTP de Cloudflare Pages
│   ├── _redirects           # Redirecciones
│   ├── robots.txt
│   └── favicon.svg
│
├── src/
│   ├── components/
│   │   ├── Header.astro
│   │   └── Footer.astro
│   │
│   ├── layouts/
│   │   └── Base.astro       # Layout principal con SEO, OG, JSON-LD
│   │
│   ├── pages/
│   │   ├── index.astro      # Home
│   │   ├── contacto.astro
│   │   │
│   │   ├── blog/
│   │   │   ├── index.astro  # Listado con búsqueda FTS5 y paginación
│   │   │   └── [slug].astro # Post individual + comentarios + visitas
│   │   │
│   │   ├── portfolio/
│   │   │   └── index.astro
│   │   │
│   │   ├── panel/           # Panel de administración (protegido)
│   │   │   ├── index.astro  # Lista de posts
│   │   │   ├── nuevo.astro  # Crear post
│   │   │   ├── comentarios.astro
│   │   │   ├── stats.astro  # Estadísticas de visitas
│   │   │   ├── editar/
│   │   │   │   └── [slug].astro
│   │   │   └── preview/
│   │   │       └── [slug].astro
│   │   │
│   │   ├── api/
│   │   │   ├── comments.ts          # POST — enviar comentario (público)
│   │   │   └── panel/
│   │   │       ├── comments.ts      # POST/DELETE — moderar comentarios
│   │   │       └── posts.ts         # DELETE — borrar post
│   │   │
│   │   ├── rss.xml.ts       # RSS feed dinámico
│   │   └── sitemap.xml.ts   # Sitemap dinámico
│   │
│   └── middleware.ts        # Basic Auth para /panel/*
│
├── patch-wrangler.mjs       # Limpia wrangler.json post-build para Pages
├── wrangler.toml            # Configuración Cloudflare (D1 binding)
├── astro.config.mjs
└── package.json
```

---

## Base de datos — Cloudflare D1

Tres tablas principales:

### `posts`
```sql
CREATE TABLE posts (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  content     TEXT,
  pub_date    TEXT NOT NULL,
  hero_image  TEXT,
  draft       INTEGER DEFAULT 0,
  tags        TEXT
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
  estado     TEXT DEFAULT 'pendiente',  -- pendiente | aprobado | rechazado
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

### Índices FTS5 (búsqueda full-text)
```sql
CREATE VIRTUAL TABLE posts_fts USING fts5(
  slug UNINDEXED, title, description, content,
  content='posts', content_rowid='rowid'
);
```
Con triggers de sincronización automática en INSERT, UPDATE y DELETE.

---

## Desarrollo local

```bash
# Instalar dependencias
npm install

# Servidor de desarrollo (puerto 3000)
npm run dev

# Build de producción
npm run build

# Preview del build
npm run preview
```

### Requisitos
- Node.js >= 22.16.0
- Cuenta en Cloudflare con D1 configurado

### Variables de entorno
El panel de administración usa Basic Auth configurado en el middleware. Las credenciales se establecen en las variables de entorno de Cloudflare Pages:

```
ADMIN_USER=tu_usuario
ADMIN_PASS=tu_contraseña
```

---

## Despliegue

El proyecto se despliega automáticamente en Cloudflare Pages con cada push a `main`.

El script `patch-wrangler.mjs` se ejecuta como parte del build (`astro build && node patch-wrangler.mjs`) para limpiar el `wrangler.json` generado por el adapter y hacerlo compatible con Cloudflare Pages.

---

## Licencia

Uso personal. No se permite la reutilización del código sin permiso del autor.
