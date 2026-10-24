# Sistema de defensa y panel (fases 1 a 4)

Módulo aislado en `src/lib/defense/`, con panel en `/panel/defensa`. No sustituye a `bot-detector.ts`: lo complementa.

## Niveles

| Nivel | Nombre | Efecto |
|---|---|---|
| 0 | Normal | Solo marcar. Listas y reglas etiquetan la visita como bot; no se bloquea nada. |
| 1 | Vigilancia | Igual, pero las visitas ya marcadas se saltan el scoring completo y KV. Con «Modo lite» tampoco se registran en `page_views`. |
| 2 | Defensa | Lista de bloqueo → 403. Reglas por IP/ASN → 429 (y baneo temporal si la regla lo dice). Las IPs del honeypot solo se marcan. |
| 3 | Mantenimiento | 503 + `Retry-After` en todo el sitio público. |

Nunca se tocan: `/panel`, `/api/panel/*`, `/api/telegram/*`. La lista blanca gana a todo.

## Cómo funciona

- `middleware.ts` llama a `defend()` antes de la autenticación del panel.
- **Sin consultas a D1/KV por petición**: listas, reglas y ajustes viven en memoria de cada isolate y se refrescan cada ~60 s.
- Contadores por hora en memoria, volcados a `defense_hourly` como mucho una vez por minuto.
- Fail open: si D1 falla o faltan tablas, la petición pasa. Interruptor maestro: `defense_enabled = 0`.

## Reglas de frecuencia (fase 2)

«X visitas cada Y segundos», por ámbito:

| Ámbito | Cuenta | Puede bloquear | Clasifica como bot |
|---|---|---|---|
| IP | por IP (IPv6: por /64) | sí (nivel 2) | sí |
| ASN | por red | sí (nivel 2) | no (solo aviso) |
| UA | mismo User-Agent desde cualquier IP | no | no (solo aviso) |
| Global | todo el tráfico | no | no (solo aviso) |

Acciones: **Marcar**, **429** (mientras supere el límite) y **429 + baneo** (añade la IP a la lista durante N minutos).
Contador en memoria con ventana deslizante aproximada: es por isolate, así que es aproximado (suficiente para un blog; no usa cuota).
Exentos: lista blanca y buscadores **verificados por ASN** (Googlebot, Bingbot y Applebot desde las redes de Google, Microsoft y Apple).

Reglas por defecto (migración 0003): Ráfaga por IP (30/60 s en `/blog/*`, baneo 15 min), Mismo UA (20/60 s, aviso) y Presión global (300/60 s, aviso).

## Auto-baneo de reincidentes (fase 2)

Una IP (o /64) con **5 visitas clasificadas como bot en 10 minutos** (puntuación ≥ 90) recibe una entrada automática de 24 h. Todo configurable en el panel. No cuenta: bots que se declaran (Googlebot, GPTBot, ClaudeBot…), buscadores verificados, lista blanca ni IPs ya listadas. Máximo 500 entradas automáticas vigentes.

## Detector de escáneres

Este blog no es WordPress ni PHP, así que quien pide `/wp-login.php`, `/.env`, `/phpmyadmin` o cualquier ruta acabada en `.php` busca vulnerabilidades. En `defend()` (solo mira la ruta: **sin consultas a D1/KV**):

- La visita se **marca como bot** (`scanner:<regla>`) y la IP (IPv6: su /64) entra en la lista de bloqueo con origen `auto`, motivo «Escáner: …» y **48 h** de duración (configurable de 1 a 720).
- Como el resto de entradas automáticas, en niveles 0–1 solo marca; en **nivel 2** esa misma petición y las siguientes reciben 403.
- Exentos: lista blanca y buscadores verificados por ASN (Google, Bing, Apple).
- Las rutas de `/blog/…` solo se comparan por extensión peligrosa (`.php`, `.env`, `.sql`…); nunca por prefijo o fragmento, para que un título como «guia-wordpress» no se confunda con un escáner.
- Estas peticiones no pasan por un artículo, así que **no aparecen en Visitas**: quedan en la lista de bloqueo, el Registro de eventos y los contadores de Actividad.
- Comparte el tope de 500 entradas automáticas vigentes con el auto-baneo.
- Lista de reglas en `src/lib/defense/scanner.ts` (`PREFIXES`, `CONTAINS`, `SUFFIXES`). Si añades al sitio una ruta que coincida con alguna, exceptúala allí.

## Alertas y control por Telegram (fase 3)

Sin cron (Pages no tiene): las alertas salen del propio flujo de visitas.

| Alerta | Cuándo salta | Por defecto |
|---|---|---|
| Ráfaga desde una IP | una IP (IPv6: un /64) supera N visitas en 60 s | 30 |
| Oleada de bots | más de N visitas de bots en 5 minutos (incluye las marcadas por listas/reglas) | 40 |

- **Un aviso de cada tipo por periodo de espera** (30 min por defecto). Se evita el duplicado entre servidores «reclamando» el hueco con un `UPDATE` condicional en `settings` (`defense_last_alert_ip`, `defense_last_alert_wave`): solo gana uno.
- Los avisos respetan el botón **Telegram ✓/✗** del panel principal (si está en ✗, no se envía nada).
- Botones del mensaje: **Bloquear IP (24 h)**, **Subir a Defensa**, **Mantenimiento** (pide confirmación) y **Ignorar**. Cada acción queda en el registro de eventos.
- Comando `/estado`: nivel actual, entradas de bloqueo y contadores de 24 h.
- Opcional: **escalar solo a Vigilancia (nivel 1)** al saltar una alerta. Nunca sube a 2 ni a 3 por su cuenta.
- Opcional: avisar por Telegram de los cambios de nivel hechos desde el panel.
- **Contenido de la alerta de ráfaga:** IP, país y red, visitas frente al umbral, páginas más visitadas (con nº de peticiones), primera y última petición en hora de Madrid y navegador. La ráfaga cuenta peticiones a cualquier ruta (también la portada), mientras que «Visitas» solo registra artículos.
- **Aviso de fallos de acceso al panel:** cuando una misma IP falla `defense_login_alert_fails` veces (3 por defecto; 0 lo desactiva) al iniciar sesión dentro de la ventana de 15 minutos, llega un aviso con IP, país/red, usuario probado (nunca la contraseña), navegador y hora de Madrid. Avisa **una sola vez por racha** y solo de fallos, no de accesos correctos. No lleva botón de bloqueo: el panel queda fuera de la defensa y la protección real es el límite existente de 5 fallos por IP cada 15 minutos (`/api/panel/auth`). Respeta «Alertas activas» y el botón «Telegram ✓/✗».
- Todo texto que no es del sistema (organización de red, etc.) se escapa antes de ir al mensaje.

**Webhook** `POST /api/telegram/webhook` (público, sin JWT):

- Exige la cabecera `X-Telegram-Bot-Api-Secret-Token` igual a `TELEGRAM_WEBHOOK_SECRET` (comparación en tiempo constante). Sin ese secret configurado, la ruta responde 404.
- Solo acepta pulsaciones del chat `TELEGRAM_CHAT_ID`. **Usa un chat privado con el bot**: en un grupo, cualquier miembro podría pulsar los botones.
- El módulo de defensa nunca la bloquea ni la pone en mantenimiento.
- Se registra con el botón «Registrar webhook» del panel (usa `setWebhook` con el secret).

**Secrets**: `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` (ya existen) y uno nuevo, `TELEGRAM_WEBHOOK_SECRET` (16–256 caracteres: letras, números, `_` y `-`).

## Panel (fase 4)

Layout común `src/layouts/Panel.astro` con barra lateral (se convierte en menú deslizante en móvil):

| Grupo | Entradas |
|---|---|
| Contenido | Posts, Nuevo post, Comentarios (con contador), Mensajes (con contador) |
| Tráfico | Estadísticas, Visitas |
| Defensa | Estado y niveles (con el nivel actual) y, dentro de la página, accesos a IPs y rangos, Reglas, Alertas, Actividad, Datos y Eventos |
| Sistema | Exportar datos, Telegram ✓/✗, modo claro/oscuro, Ver blog, Cerrar sesión |

- Los controles que antes se repetían en cada página (tema, Telegram, cerrar sesión) viven una sola vez en el layout.
- `/panel` (Posts) incluye un resumen: publicados, borradores, comentarios pendientes, mensajes sin leer, visitas humanas y bots de 24 h.
- `/panel/defensa` incluye una **estimación de uso de cuota** (cota superior): escrituras de KV y de D1 de las últimas 24 h frente al límite gratuito. Las cifras exactas están en el panel de Cloudflare.
- **Ayuda** (`/panel/defensa/ayuda`): guía rápida por situaciones, referencia punto por punto de cada ajuste (qué hace y cuándo actuar), glosario de motivos de clasificación y tabla de valores por defecto.
- En **Visitas**, la etiqueta «bot» muestra al pasar el ratón la puntuación y los motivos (si existe la columna `bot_reasons`).
- Las páginas de edición (`nuevo`, `editar`, `preview`) y `login` mantienen su diseño a pantalla completa, sin barra lateral, para no tocar el editor.

## Pruebas

```bash
npm test              # todas
npm test -- scanner   # solo las que contengan «scanner» en el nombre del fichero
```

Sin dependencias nuevas ni red: `scripts/test.mjs` compila `tests/**/*.test.ts` con esbuild y las ejecuta con `node --test`, cada fichero en su propio proceso. La D1 se simula en memoria (`tests/helpers/fake-d1.ts`) y Telegram con un `fetch` falso (`tests/helpers/telegram.ts`); si el código usa una consulta SQL que la D1 simulada no conoce, la prueba falla con «SQL no soportado».

| Fichero | Qué cubre |
|---|---|
| `ip.test.ts` | IPv4/IPv6, CIDR, /64, listas por IP, rango, ASN y país |
| `defend.test.ts` | Niveles 0–3, lista blanca, honeypot, mantenimiento (503, Retry-After, escapado), fallos de D1 |
| `rules.test.ts` | Limitador, reglas por IP/UA/ASN/global, exención de Googlebot, auto-baneo |
| `scanner.test.ts` | Rutas de escáner y legítimas (sin falsos positivos), baneo de 48 h, niveles, exenciones, IPv6 |
| `alerts.test.ts` | Alertas de ráfaga y oleada (páginas, hora de Madrid, escapado), escalada, avisos de cambios |
| `login-alert.test.ts` | Aviso de fallos de acceso al panel (umbral exacto, escapado, desactivación) |
| `telegram-bot.test.ts` | Botones, doble confirmación, autorización por chat, `/estado` |
| `reset.test.ts` | Restablecer configuración |

Convención: cada prueba que toca la memoria del módulo empieza con `resetDefenseMemory()` (solo para tests). Las pruebas de punta a punta con Cloudflare real (wrangler) no están en el repo.

## Restablecer configuración

Botón al final de `/panel/defensa`. Devuelve ajustes (nivel 0, interruptores, umbrales de alertas y auto-baneo, detector de escáneres, aviso de fallos de acceso, mensaje de mantenimiento) y reglas (se recrean las 3 por defecto) a los valores de fábrica, en un único lote. No toca listas de bloqueo/blanca, eventos, visitas ni el botón general de Telegram.

## Retención de datos

| Dato | Se conserva |
|---|---|
| `page_views` de bots | 30 días |
| `page_views` humanas | ~13 meses (las estadísticas muestran 12) |
| `bot_ips` (honeypot) | 30 días |
| `defense_events` | 90 días |
| `defense_hourly` | 30 días |
| Bloqueos caducados | 7 días tras caducar |

La poda es **manual** desde el panel (con vista previa) o **automática diaria** si activas el interruptor (desactivado por defecto: el borrado es irreversible). Máximo 20.000 filas por tabla y ejecución para no gastar las 100.000 escrituras diarias de D1.

## Despliegue

```bash
# Fase 1 (si no lo has hecho)
npx wrangler d1 execute mi-blog-db --remote --file=db/migrations/0001_defense_tables.sql
npx wrangler d1 execute mi-blog-db --remote --file=db/migrations/0002_bot_reasons.sql   # una sola vez
# Fase 2
npx wrangler d1 execute mi-blog-db --remote --file=db/migrations/0003_defense_rules_seed.sql
# Revisión: índices para que el refresco de listas no recorra tablas enteras
npx wrangler d1 execute mi-blog-db --remote --file=db/migrations/0004_defense_indexes.sql
# Detector de escáneres, aviso de fallos de acceso y pruebas: sin migración nueva.
# Fase 3: sin migración nueva. Añade el secret TELEGRAM_WEBHOOK_SECRET en Cloudflare Pages,
# despliega y pulsa «Registrar webhook» en /panel/defensa.
git add -A && git commit -m "Defensa y rediseño del panel (fases 1-4)" && git push
```
