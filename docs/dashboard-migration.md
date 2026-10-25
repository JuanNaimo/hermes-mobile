# Migración: API server (:8642) → dashboard (:9119)

Objetivo: que la app entre como el desktop de Hermes, con **un solo login
(usuario/contraseña)** que da acceso a **todos los perfiles**, en lugar de una
`API_SERVER_KEY` por perfil. Investigado contra Hermes Agent **v0.22.4**
(fuente: <https://github.com/NousResearch/hermes-agent>; rutas de archivo abajo
relativas a ese repo).

Server del usuario: `http://192.168.0.107:9119`, perfiles `default` y
`tech-insider`, proveedor de login `basic`. **Está en una LAN privada**: no se
puede alcanzar desde la nube. Desarrollar contra un mock y probar contra el
server real desde la PC del usuario.

## Plan

1. ✅ Login + lista de perfiles + sesiones (REST). **Hecho contra el mock**
   (`scripts/mock-dashboard.mjs`); falta probarlo contra el server real.
2. Chat por WebSocket JSON-RPC (reemplaza el SSE de `/api/sessions/{id}/chat/stream`).
3. Aprobaciones, stop, skills y jobs vía dashboard.
4. Mantener el modo API key actual como alternativa en la pantalla de conexión
   hasta que el modo dashboard esté completo.
5. Extender `scripts/mock-server.mjs` (o un mock nuevo) para imitar el dashboard.

## Verificado contra el server real (sin login)

- `GET /` → 302 a `/login`.
- `GET /api/auth/providers` (público) →
  `{"providers":[{"name":"basic","supports_password":true,...},{"name":"nous","supports_password":false,...}]}`.
- `GET /api/status` es público. `GET /api/profiles` y `GET /api/ws` → 401 sin token.
- CORS: preflight desde `http://localhost` y `http://localhost:5180` → permitido
  (`allow-headers: authorization`); desde `http://example.com` → 400.
- WebSocket `/api/ws` con `Origin: http://localhost` → **400 antes de autenticar**;
  sin `Origin` → 403 (token inválido). O sea, el chequeo de Origin rechaza la
  WebView (ver "Bloqueos").
- `GET /auth/native/authorize?provider=basic&...` → 302 a `/login` (flujo PKCE activo).

## Login (proveedor `basic`)

Rutas en `hermes_cli/dashboard_auth/routes.py`. (`web_server_oauth.py` es OAuth de
proveedores de inferencia, no del dashboard.)

- `POST /auth/password-login {provider, username, password, next?}` solo setea
  cookies HttpOnly SameSite=Lax (`hermes_session_at` / `_rt`); **no devuelve tokens**.
- Flujo nativo (RFC 8252) que usa el desktop, y el que hay que replicar:
  1. `GET /auth/native/authorize?provider=basic&code_challenge=<S256(verifier)>&code_challenge_method=S256&redirect_uri=http://127.0.0.1:<port>/cb&state=<s>`
     → 302 a `/login` + cookie `hermes_session_pkce`. `redirect_uri` debe ser IP loopback.
  2. `POST /auth/password-login` **con esa cookie** →
     `{"ok":true,"next":"http://127.0.0.1:<port>/cb?code=<code>&state=<s>"}`.
     No hace falta escuchar en el loopback: el `code` ya viene en `next`.
  3. `POST /auth/native/token {code, code_verifier}` →
     `{access_token, refresh_token, token_type:"Bearer", expires_at, provider, user_id}`.
     El code es de un solo uso y vence a los 120 s.
- Refresh: `POST /auth/native/refresh {refresh_token, provider:"basic"}` → misma
  forma; 401 `{"error":"session_expired"}` si venció. Access 12 h, refresh 30 días.
- Requests: `Authorization: Bearer <access_token>`. El server no rota tokens: el
  cliente refresca solo.
- Como entre los pasos 1 y 2 hay que conservar una cookie (y el CORS no tiene
  `allow_credentials`), **un `fetch` cross-origin no alcanza**:
  - APK: usar `CapacitorHttp` (HTTP nativo, sin CORS, con cookie jar).
  - Dev en navegador: proxy de Vite (`/auth`, `/api` → server) para que sea same-origin.

## Perfiles

- `GET /api/profiles` → `{"profiles":[...]}` (`web_routers/profiles.py`).
- REST por perfil: query `?profile=<nombre>` (algunas llamadas lo llevan en el body).
- Sesiones de todos los perfiles: `GET /api/profiles/sessions?profile=all&limit=…`.
- Un login cubre todos los perfiles (el usuario basic no está atado a un perfil).

## Chat: WebSocket JSON-RPC 2.0 en `/api/ws`

- Auth: `?token=<access_token>` o `?ticket=` de `POST /api/auth/ws-ticket` (un uso, 30 s).
- Al conectar llega `gateway.ready`. Llamar primero
  `client.capabilities {"server_requests": true}` o las aprobaciones fallan.
- Eventos: `{"jsonrpc":"2.0","method":"event","params":{type, session_id, payload}}`.
- Métodos (contratos en `tui_gateway/contracts/`):
  - `session.list {profile, limit}` · `session.create {profile, title?}` →
    `{session_id, stored_session_id, messages, ...}`
  - `session.resume {session_id: <id guardado>, profile}` → id de runtime + mensajes
  - `prompt.submit {session_id: <id runtime>, text, profile?}` (responde ack; la
    salida llega por eventos)
  - `session.interrupt {session_id}` (stop) · `session.close` · `ping`
- Tipos de evento: `message.start`, `message.delta {text}`, `reasoning.delta {text}`,
  `thinking.delta`, `message.interim`, `tool.generating`, `tool.start {tool_id, name, args}`,
  `tool.progress`, `tool.complete {tool_id, name, result, summary, duration_s}`,
  `status.update`, `message.complete {text, usage, status: complete|error|interrupted}`,
  `session.info`, `error {message}`, `request.cancel`.
- Aprobaciones: request server→cliente
  `{"jsonrpc":"2.0","id":…,"method":"approval","params":{session_id, request_id, command, description, choices, tool_name}}`;
  responder con result `{choice}` o llamar `approval.respond {session_id, request_id, choice}`.
  También existen `clarify`, `sudo`, `secret`.
- Historial por REST: `GET /api/sessions/{id}/messages?profile=…`.

## Skills y jobs

- Skills: `GET /api/skills?profile=` (con `enabled`, `usage`, `provenance`),
  `PUT /api/skills/toggle?profile=`. Puede andar aunque `/v1/skills` del API
  server devuelva 500 (pasa en el server del usuario).
- Cron: `GET /api/cron/jobs?profile=all|<nombre>`; `POST /api/cron/jobs`,
  `PUT|DELETE /api/cron/jobs/{id}`, `POST /api/cron/jobs/{id}/pause|resume|trigger`.

## Bloqueos y cambios en el server

1. **Origin del WebSocket**: la WebView manda `Origin: http://localhost`, que pasa
   solo si el dashboard está bindeado a `0.0.0.0`/`::` (`web_server_boundary.py`,
   `ws_host_origin_reason`). Opciones: bindear el dashboard a `0.0.0.0`, o abrir el
   socket desde código nativo sin header `Origin`.
2. **Secreto fijo**: setear `HERMES_DASHBOARD_BASIC_AUTH_SECRET` (o
   `dashboard.basic_auth.secret`); si no, cada reinicio invalida todos los tokens.
3. CORS: hardcodeado a `http(s)://(localhost|127.0.0.1)(:puerto)?`. Alcanza para
   Android y dev; iOS (`capacitor://localhost`) o un hosting en la LAN necesitarían
   parchear Hermes.
4. Si el chat embebido del dashboard está deshabilitado, `/api/ws` cierra con 4403.

## Estado del paso 1

- Código: `src/lib/dashboard.ts` (login nativo PKCE, refresh con margen de 2 min y un
  solo refresh concurrente, reintento ante 401), `src/lib/http.ts` (CapacitorHttp con
  `disableRedirects` y cookie de PKCE reenviada a mano; `fetch` same-origin vía proxy en
  el navegador), proxy `/hermes-dashboard` en `vite.config.ts` (reescribe `Host`, saca
  `Origin` y `Referer`).
- Verificado contra el mock: login, contraseña incorrecta, refresh antes del
  vencimiento, refresh revocado → vuelve al login con el usuario precargado, perfiles,
  sesiones de todos los perfiles y filtradas, historial. También desde un origen
  `http://<ip-lan>:5180` sin WebCrypto (usa el SHA-256 en JS).
- **Sin probar**: el camino nativo (CapacitorHttp en un APK) y el server real.
  Para el server real desde la PC: `HERMES_DASHBOARD=http://192.168.0.107:9119 pnpm dev`.
- En modo dashboard el chat queda en solo lectura; Jobs y Skills se ocultan.

Nada de esto fue probado todavía con un token real.
