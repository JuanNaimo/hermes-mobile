# Hermes Mobile

Cliente para tablets (y teléfonos) que se conecta a tu servidor
[Hermes Agent](https://github.com/NousResearch/hermes-agent). Usa el mismo design
system que el dashboard oficial (`@nous-research/ui`, paleta Hermes Teal, tipografías
Collapse / Mondwest / Courier Prime), con un layout pensado para pantallas táctiles.

![Chat en tablet horizontal](docs/screenshots/chat-landscape.png)

| Vertical | Conexión |
|---|---|
| ![Chat en tablet vertical](docs/screenshots/chat-portrait.png) | ![Pantalla de conexión](docs/screenshots/connect.png) |

## Qué hace

- **Chat con streaming**: las respuestas llegan token a token por
  `POST /api/sessions/{id}/chat/stream` (SSE). Muestra el razonamiento (plegable),
  cada llamada a herramienta con sus argumentos y su resultado, y el markdown con
  tablas y bloques de código copiables.
- **Aprobaciones**: si Hermes pide confirmación para un comando peligroso, aparece
  una tarjeta para permitirlo una vez, en la sesión, siempre, o denegarlo
  (`POST /v1/runs/{id}/approval`). Detener una respuesta usa `POST /v1/runs/{id}/stop`.
- **Sesiones**: lista con búsqueda, fijadas y recientes, crear, ramificar (fork),
  renombrar y borrar. Las conversaciones siguen corriendo si cambiás de sesión.
- **Imágenes**: adjuntá fotos o capturas desde la cámara o la galería. Se reducen a
  1600 px antes de enviarse.
- **Jobs**: ver, crear, pausar, reanudar, ejecutar y borrar los cron jobs de Hermes.
- **Skills y toolsets** disponibles en el servidor.
- **Servidor**: estado (readiness), funciones, y ajustes de apariencia: los temas del
  dashboard más el tema **Nous Research**, texto grande y comportamiento de Enter.
- **Layout táctil**: en horizontal (≥ 1024 px) el panel lateral queda fijo y se puede
  ocultar. En vertical y en teléfonos pasa a ser un cajón. Todos los botones miden al
  menos 44 px y la app respeta las áreas seguras (notch y barra de inicio).
- **PWA instalable**: incluye manifest y service worker, así que podés agregarla a la
  pantalla de inicio. También se puede empaquetar como app nativa con Capacitor.

## Tema Nous Research

Replica el look de nousresearch.com a partir del design system `@nous-research/ui`,
que es el que arma ese sitio:

- **Colores**: el lens `LENS_5I` del sitio (`#170d02` / `#FFAC02`) visto a través de su
  capa `difference` blanca. El resultado es azul Nous `#0053FD` sobre crema `#E8F2FD`.
- **Imagen**: el grabado clásico del sitio (`filler-bg0.webp`) de fondo a pantalla
  completa, que se desvanece hacia la columna de lectura para que el texto se lea bien.
- **Letras**: Collapse para el texto, Mondwest para los títulos y Courier Prime para el
  código.
- **Detalles**: la mascota de Nous junto al logo de Hermes, esquinas rectas y grano.

Se elige en **Servidor → Apariencia**.

![Tema Nous Research](docs/screenshots/theme-nous.png)

## 1. Preparar el servidor Hermes

La app habla con el **API server** del gateway (no con el dashboard de `:9119`). En la
máquina donde corre Hermes, en `~/.hermes/.env`:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=una-clave-larga-y-secreta
# Escuchar en la red local, no solo en 127.0.0.1:
API_SERVER_HOST=0.0.0.0
# Orígenes desde donde se abre la app (ver tabla abajo):
API_SERVER_CORS_ORIGINS=http://192.168.1.50:5180,http://localhost,capacitor://localhost
```

Después reiniciá el gateway con `hermes gateway`. Por defecto escucha en el puerto `8642`.

| Cómo abrís la app | Origen que va en `API_SERVER_CORS_ORIGINS` |
|---|---|
| `pnpm dev` / `pnpm preview` desde otra máquina | `http://<ip-de-esa-máquina>:5180` |
| App Android (Capacitor) | `http://localhost` |
| App iOS / iPadOS (Capacitor) | `capacitor://localhost` |
| Cualquier hosting estático | la URL exacta, p. ej. `https://hermes.midominio.com` |

La pantalla de conexión muestra el origen exacto que tenés que agregar.

> **Ojo con HTTPS.** Una página servida por `https://` no puede llamar a un servidor
> `http://` (el navegador lo bloquea como contenido mixto). O servís las dos cosas por
> HTTP en tu LAN, o ponés el gateway detrás de un proxy con TLS (Caddy, Tailscale
> Serve, Cloudflare Tunnel…).

> **Renombrar sesiones.** El API server no incluye `PATCH` en los métodos CORS
> permitidos. Por eso, desde el navegador, renombrar falla, y la app te lo avisa. El
> resto de las acciones funciona sin problemas.

## 2. Correr la app

Requiere Node 22 y [pnpm](https://pnpm.io) 10 (`corepack enable` lo activa con la versión fijada en `package.json`).

```bash
pnpm install
pnpm dev           # http://0.0.0.0:5180, accesible desde la tablet en tu LAN
```

En la tablet abrí `http://<ip-de-tu-pc>:5180`, completá la URL del servidor
(p. ej. `http://192.168.1.20:8642`) y la API key, y listo. Para dejarla como app:
en Safari, *Compartir → Agregar a inicio*. En Chrome, *Instalar app*.

### Build estático

```bash
pnpm build         # genera dist/, servible desde cualquier hosting estático
pnpm preview       # sirve dist/ en :5180
```

### App nativa (Capacitor)

```bash
pnpm cap:android   # genera android/ y abre Android Studio
pnpm cap:ios       # genera ios/ y abre Xcode (requiere macOS)
```

La config (`capacitor.config.ts`) sirve la app desde `http://localhost` en Android, así
puede hablar con un gateway HTTP en tu LAN. En iOS, si tu gateway no tiene TLS, agregá
`NSAppTransportSecurity → NSAllowsLocalNetworking = YES` en `ios/App/App/Info.plist`.

## Desarrollo sin servidor real

`scripts/mock-server.mjs` imita la parte del API server que usa la app: sesiones,
streaming con razonamiento, herramientas y una aprobación (pedile que "borre" algo),
además de jobs y skills.

```bash
pnpm mock          # http://0.0.0.0:8642, API key: dev
pnpm dev
```

## Estructura

```
src/
├── lib/
│   ├── api.ts          # cliente tipado del API server (sesiones, SSE, runs, jobs)
│   ├── sse.ts          # parser SSE incremental (el stream es un POST, sin EventSource)
│   ├── transcript.ts   # historial + eventos SSE → items del chat (reducer puro)
│   └── runs.ts         # turnos en curso fuera de React (no se cortan al navegar)
├── components/         # sidebar, composer, mensajes, markdown, primitivas táctiles
├── pages/              # Conexión, Chat, Jobs, Skills, Servidor
├── themes/presets.ts   # paletas del dashboard (Hermes Teal, Midnight, Ember…)
└── store.tsx           # conexión, ajustes, sesiones
```

```bash
pnpm test          # tests del parser SSE y del reducer del chat
pnpm typecheck
```
