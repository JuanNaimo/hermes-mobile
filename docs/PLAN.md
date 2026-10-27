# Plan: pendientes de hermes-mobile

Estado al 26/10/2026. Pensado para seguir en una sesión en la nube (Claude Code web), sin la tablet ni el servidor Hermes de la red local.

## Antes de empezar

- **El trabajo de la última sesión tiene que estar commiteado y pusheado** a `origin` (rama `claude/dazzling-allen-lg99lt`). Si no, la nube no lo ve: voz, modelo/esfuerzo, menú de sesión, contexto, todos, slash, bots.
- **Código del servidor como referencia**: `git clone --filter=blob:none https://github.com/NousResearch/hermes-agent` (la copia local estaba en el commit `4d04303818`, versión 0.22.4). Lo que importa:
  - `hermes_cli/web_routers/*.py`: la API REST del dashboard.
  - `tui_gateway/` y `hermes_cli/web_server*.py`: los métodos JSON-RPC de `/api/ws`.
  - `apps/desktop/src/app/*`: la referencia de paridad con Desktop.
- **Probar sin servidor real**:
  - `node scripts/mock-dashboard.mjs` levanta el mock en `:9119` (usuario `hermes` / clave `hermes`), y `pnpm dev` levanta la app.
  - `pnpm typecheck` y `pnpm test` corren los tests de node contra el mock (hoy pasan 36).
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
  - Permiso de micrófono: `RECORD_AUDIO` está en el AndroidManifest local, documentado en el README.
  - Formato que graba el WebView (webm/opus) y que lo acepte `/api/audio/transcribe`.
  - Reproducción de `/api/audio/speak`.
- [ ] **Bots contra el servidor real**:
  - Forma real de `env_vars` y `state`.
  - Flujo QR de Telegram completo.
  - WhatsApp: necesita el bridge de node en el server.
  - Respuestas 409 por conflicto de multiplexer.
  - Que `gateway/restart` no deje la UI en un estado viejo: hoy recarga a ciegas a los 6 s.
- [ ] **Modelo/esfuerzo/rápido/YOLO**: que el cambio se refleje en `session.info` y que el catálogo de `model.options` coincida.

## 2. Paridad con Hermes Desktop (se puede hacer en la nube)

En orden de prioridad sugerido. Para cada uno: leer la carpeta de Desktop y el endpoint o RPC, sumar el método al cliente, la UI, el mock y un test.

1. **Reconectar a un turno en curso**. Al reabrir la app o cambiar de sesión mientras Hermes responde, hoy se pierde el streaming.
   - Ver cómo Desktop retoma: `apps/desktop/src/app/session`, `open-session.ts`.
   - Archivos de la app: `dashboardChat.attach()` y `sessionLive.ts`.
2. **Cola / steer mientras está ocupado**: escribir mientras corre un turno, para encolar o redirigir. Desktop: `chat/`. Ver los RPC `prompt.*` / `steer` en `tui_gateway`.
3. **Adjuntar archivos y PDF**: hoy solo se adjuntan imágenes.
   - Ver `ManagedFileUpload` (`data_url`, `path`) en `hermes_cli/web_models.py` y su router.
   - Archivos de la app: `Composer.tsx`.
4. **Subagentes (sección Agents)**: árbol de subagentes por sesión. Desktop: `apps/desktop/src/app/agents` (`buildSubagentTree`, `$subagentsBySession`).
5. **Línea de estado** (`status.update`): qué está haciendo el agente ahora («leyendo archivo…»), arriba del composer.
6. **`/btw` y `/background`**: preguntas al costado y tareas en segundo plano sin cortar el turno.
7. **Búsqueda en el servidor**: hoy el buscador de sesiones filtra solo lo cargado. Buscar el endpoint de búsqueda en `web_routers/sessions*.py`.
8. **Modelo por defecto global** del perfil (no solo por sesión). Desktop: `model-picker-overlay.tsx`, `settings/`.
9. **Webhooks**: lista, alta y baja, con el secreto visible una sola vez. API en `hermes_cli/web_routers/ops.py` (`_webhook_route_summary`); Desktop: `app/webhooks`. Encaja como pestaña en Bots.
10. Menor prioridad: reacciones, artifacts (`app/artifacts`), import de sesiones (`app/session-import`), ajustes de config (`app/settings`).

## 3. Deuda conocida

- `BotsPage`: después de `restartGateway` recarga con `setTimeout(6000)`. Mejor hacer polling de `/api/status` hasta que el gateway esté arriba.
- `mutate()` reintenta una sola vez ante `revision_conflict`. Revisar si alcanza en uso real.
- El bundle principal pasa el límite de tamaño de vite. Partir las páginas con `lazy()`: Jobs, Skills, Bots, Servidor.
- `android/` se genera y está ignorado. Los permisos de audio hay que volver a agregarlos si se regenera; ver el README. Evaluar un script que los parchee después de `cap add`.

## Verificación local (cuando vuelva a la PC)

```sh
git pull
pnpm install
pnpm build && npx cap sync android
cd android && JAVA_HOME=$HOME/.sdkman/candidates/java/21.0.5-tem ./gradlew assembleDebug
~/Android/Sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Después recorrer la sección 1 en la tablet (Galaxy Tab S8) contra `http://192.168.0.107:9119`.
