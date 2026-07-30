# Sistema de Detección de Bots por Scoring

Este documento describe la arquitectura, lógica de negocio y capas de detección del sistema de clasificación de bots implementado en este proyecto.

El sistema está diseñado específicamente para ejecutarse en entornos edge (**Cloudflare Workers**) de forma no bloqueante, almacenando métricas y resultados asíncronamente en **Cloudflare D1** (base de datos relacional) y realizando el rate limiting de velocidad mediante **Cloudflare KV**.

---

## 🚀 Arquitectura General

El detector de bots opera bajo un principio de **Scoring Acumulativo (0 a 100)** en lugar de un bloqueo binario directo. Esto permite clasificar el tráfico de forma flexible y actuar según la puntuación obtenida.

```
                  ┌──────────────────────────────┐
                  │      Petición entrante       │
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────────┐
                  │ Capa 0: Exclusión (Whitelist)│ ──► [Score: 0 (Humano/Confianza)]
                  └──────────────┬───────────────┘
                                 │ (No whitelisted)
                                 ▼
                  ┌──────────────────────────────┐
                  │ Capa 1: Análisis de Cabeceras│ ──► [Falta UA, accept, lang, etc.]
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────────┐
                  │ Capa 2: Patrones User-Agent  │ ──► [Known bots, Scrapers, UAs cortos]
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────────┐
                  │ Capa 3: Rate Limiting (KV/D1)│ ──► [Ráfagas en 1s o límites en 60s]
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────────┐
                  │ Capa 4: Honeypot (IPs D1)    │ ──► [¿Ha caído antes en la trampa?]
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────────┐
                  │ Capa 5: Spoofing y Red (RTT) │ ──► [Datacenters simulando navegadores]
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────────┐
                  │      Puntuación Final        │ ──► [Umbral >= 50: Is Bot]
                  └──────────────────────────────┘
```

---

## 🛡️ Detalle de las Capas de Scoring

### Capa 0: Exclusiones Previas (Whitelist)
Antes de aplicar cualquier análisis penalizador, el sistema verifica si la solicitud cumple con criterios de confianza para evitar falsos positivos en servicios legítimos (ej. webhooks de Stripe, deploys de Vercel, monitores de uptime, etc.). Si coincide con alguna regla de esta capa, el análisis finaliza con **Score: 0**.

*   **Por Ruta (`WHITELISTED_PATHS`)**:
    *   `/api/contacto`, `/api/webhooks/*`, `/api/stripe/*`.
*   **Por User-Agent (`WHITELISTED_UA`)**:
    *   Coincidencias para `stripe/`, `vercel`, `supabase`, `uptime`, `kuma`, `statuscake`, `pingdom`.
*   **Por ASN (`WHITELISTED_ASNS`)**:
    *   ASN de Cloudflare (`13335`) y proxies internos autorizados.

---

### Capa 1: Análisis Estático de Cabeceras
Se inspeccionan las cabeceras HTTP estándar que envían los navegadores reales.
*   **Falta de User-Agent**: `+80` puntos.
*   **Falta de cabecera `accept-language`**: `+15` puntos.
*   **Cabecera `accept` vacía o genérica (`*/*`)**: `+10` puntos.
*   **Presencia de `sec-fetch-mode: navigate`**: `-20` puntos (factor atenuante que reduce el score).
*   **Cloudflare Bot Score (si está disponible en planes avanzados)**: Si `cfBotScore < 30`, se suma `+40` puntos.

---

### Capa 2: Clasificación por Expresiones Regulares del User-Agent
Clasificación de agentes según la cadena de User-Agent:
*   **Bots de Indexación Conocidos (`KNOWN_BOTS`)**: `+90` puntos.
    *   *Ejemplos*: Googlebot, Bingbot, Baiduspider, Yandexbot, Applebot, TelegramBot, etc.
*   **Herramientas de automatización / Scraping (`SCRAPER_UA`)**: `+60` puntos.
    *   *Ejemplos*: Curl, Wget, Python-requests, Scrapy, Node-fetch, Axios, Go-http-client, Puppeteer, Playwright, Selenium.
*   **UAs sospechosos o extremadamente cortos** (ej. menor a 30 caracteres o simplemente `Mozilla/5.0` sin sistema operativo): `+30` puntos.

---

### Capa 3: Rate Limiting & Variabilidad de Agentes (KV + D1)
Controla la velocidad y el comportamiento temporal del cliente utilizando **Cloudflare KV** con fallback a **D1**:
*   **Ráfaga extrema en el mismo segundo**:
    *   `>= 3` peticiones/segundo: `+70` puntos.
    *   `>= 2` peticiones/segundo: `+35` puntos.
*   **Ventana de 60 segundos**:
    *   `>= 15` visitas: `+50` puntos.
    *   `>= 8` visitas: `+25` puntos.
*   **Rotación de User-Agent (`getDistinctUACount`)**:
    *   Si una misma IP utiliza `2` User-Agents distintos en un minuto: `+20` puntos.
    *   Si utiliza `>= 3` User-Agents distintos en un minuto: `+60` puntos (patrón clásico de bots con rotación).

---

### Capa 4: Honeypot (Lista Negra persistente en D1)
El sitio expone un enlace oculto al ojo humano (oculto mediante CSS y accesibilidad) en `/trap`.
*   Cualquier acceso a este endpoint asume que el cliente es un crawler ciego.
*   Su IP se registra en la tabla D1 `bot_ips`.
*   Cualquier petición posterior desde esa IP activa esta capa sumando `+100` puntos (**Score: 100**).

---

### Capa 5: Detección de Datacenters y Suplantación (Browser Spoofing)
La regla de oro para cazar scrapers sofisticados (ej. Puppeteer/Playwright corriendo desde la nube simulando ser un usuario real):
1.  **Detección de Datacenter**: Se comprueba si el ASN mapea a una infraestructura Cloud/Hosting (`HOSTING_ORGS` ej. AWS, GCP, Hetzner, OVH, DigitalOcean, etc.).
2.  **Suplantación**: Se detecta si el User-Agent afirma ser un navegador normal (`Mozilla/5.0`, `Chrome`, `Safari`, etc.) pero **no** es un bot de indexación verificado (`cf?.botManagement?.verifiedBot !== true`).
    *   Si se cumplen ambas condiciones: `+40` puntos (motivo: `browser-spoofing`).
3.  **Análisis RTT (Round Trip Time)**:
    *   Los datacenters tienen conexiones de fibra directa y peering de alta velocidad hacia Cloudflare, resultando en latencias de red extremadamente bajas (`cf?.clientTcpRtt < 10 ms`).
    *   Los usuarios residenciales/móviles (4G/5G) rara vez bajan de `20 ms - 150 ms`.
    *   Si hay spoofing + RTT ultrabajo en Datacenter: `+30` puntos (motivo: `low-rtt-datacenter`).
    *   *Resultado*: Con `+70` puntos acumulados, los scrapers en la nube son clasificados inmediatamente como bots (`score >= 50`).

---

## 🗄️ Esquema de Datos de Soporte

Para que el sistema funcione correctamente, se apoya en las siguientes tablas de base de datos relacional (D1):

### 1. Tabla `page_views`
Registra el historial de visitas para análisis temporal y rate limiters.
```sql
CREATE TABLE page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  ip TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  user_agent TEXT,
  referer TEXT,
  is_bot INTEGER DEFAULT 0,
  bot_score INTEGER DEFAULT 0
);
```

### 2. Tabla `bot_ips`
Registra de forma persistente las IPs que han caído en el Honeypot.
```sql
CREATE TABLE bot_ips (
  ip TEXT PRIMARY KEY,
  detected_at TEXT NOT NULL,
  method TEXT NOT NULL
);
```
