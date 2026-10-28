# Plan: pendientes de hermes-mobile

Estado al 27/10/2026. Pensado para seguir en una sesión en la nube (Claude Code web), sin la tablet ni el servidor Hermes de la red local.

## Antes de empezar

- **El trabajo de la última sesión tiene que estar commiteado y pusheado** a `origin` (rama `claude/dazzling-allen-lg99lt`). Si no, la nube no lo ve: voz, modelo/esfuerzo, menú de sesión, contexto, todos, slash, bots.
- **Código del servidor como referencia**: `git clone --filter=blob:none https://github.com/NousResearch/hermes-agent` (la copia local estaba en el commit `4d04303818`, versión 0.22.4). Lo que importa:
  - `hermes_cli/web_routers/*.py`: la API REST del dashboard.
  - `tui_gateway/` y `hermes_cli/web_server*.py`: los métodos JSON-RPC de `/api/ws`.
  - `apps/desktop/src/app/*`: la referencia de paridad con Desktop.
- **Probar sin servidor real**:
  - `node scripts/mock-dashboard.mjs` levanta el mock en `:9119` (usuario `hermes` / clave `hermes`), y `pnpm dev` levanta la app.
  - `pnpm typecheck` y `pnpm test` corren los tests de node contra el mock (hoy pasan 55).
  - El mock solo implementa el **modo legacy**. Todo lo nuevo tiene que entrar al mock y a `tests/` en el mismo cambio.
- **En la nube no se puede**:
  - Compilar el APK: necesita JDK 21 y el SDK de Android, y `android/` está en `.gitignore`.
  - Probar en la tablet.
  - Llegar al dashboard real (`192.168.0.107:9119`).

  Eso queda para la sesión local (ver «Verificación local» al final).

## 1. Verificar contra el servidor real (local, bloquea dar cosas por cerradas)

Nada de esto se probó todavía fuera del mock.

- [ ] **Saber en qué modo corre el servidor**: legacy (`hermes dashboard`) o authority (gateway con `session_authority` en `gateway.ready`). Muchas rutas de `src/lib/dashboardChat.ts` cambian según el modo.
- [ ] **Modo authority**:
  - El formato de confirmación de modelo caro en `setModel`: hoy manda `{model, provider, confirm:true}` y no está confirmado.
  - El id de fila que usa `retry`/`rewind`: lo parsea de la key `h-<id>` en `ChatView.retryLast`.
  - Leer `session.mutate` en el server y ajustar.
- [ ] **Voz en el dispositivo**:
  - Permiso de micrófono: `RECORD_AUDIO` lo agrega `pnpm cap:patch` (ver el README).
  - Formato que graba el WebView (webm/opus) y que lo acepte `/api/audio/transcribe`.
  - Reproducción de `/api/audio/speak`.
- [ ] **Bots contra el servidor real**:
  - Forma real de `env_vars` y `state`.
  - Flujo QR de Telegram completo.
  - WhatsApp: necesita el bridge de node en el server.
  - Respuestas 409 por conflicto de multiplexer.
- [ ] **Modelo/esfuerzo/rápido/YOLO**: que el cambio se refleje en `session.info` y que el catálogo de `model.options` coincida.
- [ ] **Reconexión a un turno en curso**: cortar el Wi-Fi de la tablet unos segundos a mitad de una respuesta y ver que
  siga sin duplicar texto (`session.events.since`); cerrar y reabrir la app con un turno corriendo (in-flight de
  `session.resume`, `open_requests`). El servidor da ~20 s de gracia antes de cortar un turno sin cliente.
- [ ] **Cola y Corregir**: que el agente del servidor acepte `session.steer` (si contesta 4010 la app lo manda a la cola)
  y que la corrección llegue en el próximo paso.
- [ ] **Archivos**: un PDF real por `file.attach` (límite de la app: 20 MB) y que el agente lo lea con la ref `@file:`.
- [ ] **Subagentes, `/btw`, `/background`, webhooks, búsqueda y modelo por defecto** contra el servidor real: forma
  real de los eventos `subagent.*`, `btw.complete`/`background.complete`, `/api/webhooks*`, `/api/sessions/search` y
  `/api/model/set`.
- [ ] **Línea de estado**: qué textos manda `status.update` en la práctica (la app oculta `"ready"`).
- [ ] **Reinicio del gateway** en Bots: que `/api/actions/gateway-restart/status` y `/api/status?profile=` alcancen para
  saber cuándo volvió.

## 2. Paridad con Hermes Desktop (se puede hacer en la nube)

En orden de prioridad sugerido. Para cada uno: leer la carpeta de Desktop y el endpoint o RPC, sumar el método al cliente, la UI, el mock y un test.

1. ✅ **Reconectar a un turno en curso** (27/10). Si el socket se cae a mitad de un turno, `DashboardChat` reconecta,
   hace `session.resume` (el servidor mantiene el turno vivo sin cliente) y pide lo perdido con `session.events.since`
   según el `seq` de cada evento; si la ventana de replay ya no alcanza, rearma la respuesta desde el `inflight`.
   Abrir una sesión que está corriendo la sigue desde el snapshot de `session.resume`, con las preguntas pendientes
   (`open_requests`). Un `message.start` de un turno que la app no mandó (otro dispositivo, la cola del servidor)
   también se sigue. Al volver del segundo plano se hace ping enseguida.
2. ✅ **Cola / corregir mientras está ocupado** (27/10). Enter encola en la app (como la cola de Desktop) y la cola se
   manda sola al terminar el turno; después de un stop o error queda en espera. "Corregir" usa `session.steer`.
   No se usa `busy_input_mode` del servidor: la app nunca manda `prompt.submit` con el turno ocupado.
3. ✅ **Adjuntar archivos y PDF** (27/10). `file.attach {name, data_url}` (no `ManagedFileUpload`, que es el gestor de
   archivos del dashboard) y las refs `@file:` al principio del prompt, como Desktop. Se muestran como chips.
4. ✅ **Subagentes** (28/10): los eventos `subagent.*` arman un árbol por sesión (`src/lib/subagents.ts`, como
   `buildSubagentTree` de Desktop), plegado arriba del compositor con estado, herramienta actual y resumen. Los
   terminados se descartan al empezar el próximo turno. No abre la sesión del hijo (`child_session_id`) todavía.
5. ✅ **Línea de estado** (27/10): `status.update` o, si no hay, lo que se deduce del turno (herramienta en curso,
   pensando, escribiendo, esperando tu respuesta). También en modo API key.
6. ✅ **`/btw` y `/background`** (28/10): `prompt.btw` / `prompt.background` (también `/bg`), con o sin turno en
   curso; la respuesta llega por `btw.complete` / `background.complete` a una tarjeta bajo la conversación (no entra
   al historial). Falta ver si el servidor real emite esos eventos a un cliente que se reconectó.
7. ✅ **Búsqueda en el servidor** (28/10): en modo dashboard el buscador también consulta `/api/sessions/search`
   (uno por perfil) y muestra las coincidencias dentro de las conversaciones con el fragmento resaltado.
8. ✅ **Modelo por defecto del perfil** (28/10): en el selector de modelo, "También como predeterminado de <perfil>"
   lo guarda con `POST /api/model/set {scope: "main"}` (con la confirmación de modelos caros).
9. ✅ **Webhooks** (28/10): sección en Bots: activar la plataforma, crear (el secreto se muestra una sola vez, con
   copiar), pausar y borrar, por perfil (`/api/webhooks*`).
10. Menor prioridad: reacciones, artifacts (`app/artifacts`), import de sesiones (`app/session-import`), ajustes de config (`app/settings`).

## 3. Deuda conocida

- ✅ `BotsPage`: el reinicio espera a que termine `/api/actions/gateway-restart/status` y a que `/api/status?profile=`
  diga `gateway_running` (`DashboardClient.restartGatewayAndWait`, 90 s máximo).
- `mutate()` reintenta una sola vez ante `revision_conflict`. Revisar si alcanza en uso real.
- ✅ Jobs, Skills, Bots y Servidor cargan con `lazy()`: el bundle principal bajó de 574 KB a 430 KB.
- ✅ `scripts/patch-native.mjs` (`pnpm cap:patch`, y lo corren `cap:android`/`cap:ios`) agrega los permisos de audio
  y las claves de iOS después de `cap add`.

## Verificación local (cuando vuelva a la PC)

```sh
git pull
pnpm install
pnpm build && pnpm cap:patch && npx cap sync android
cd android && JAVA_HOME=$HOME/.sdkman/candidates/java/21.0.5-tem ./gradlew assembleDebug
~/Android/Sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Después recorrer la sección 1 en la tablet (Galaxy Tab S8) contra `http://192.168.0.107:9119`.
