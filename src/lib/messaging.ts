/**
 * Bots: the messaging platforms the gateway connects Hermes to (Telegram,
 * WhatsApp, Discord, Slack…), as the dashboard serves them
 * (hermes_cli/web_routers/messaging.py and the pairing store in ops.py).
 */

export interface PlatformEnvVar {
  key: string;
  required: boolean;
  is_set: boolean;
  /** `sk-…abcd`-style preview of a secret; never the secret itself. */
  redacted_value?: string | null;
  /** Plain value, only for list fields (allowlists). */
  value?: string | null;
  description?: string;
  prompt?: string;
  help?: string;
  url?: string | null;
  is_password: boolean;
  is_list: boolean;
  advanced?: boolean;
}

export type PlatformState =
  | "connected"
  | "disabled"
  | "not_configured"
  | "pending_restart"
  | "gateway_stopped"
  | "startup_failed"
  | "fatal"
  | "connecting"
  | "retrying"
  | (string & {});

export interface MessagingPlatform {
  id: string;
  name: string;
  description?: string;
  docs_url?: string | null;
  enabled: boolean;
  configured: boolean;
  gateway_running: boolean;
  state: PlatformState;
  error_code?: string | null;
  error_message?: string | null;
  home_channel?: { chat_id?: string; name?: string } | null;
  env_vars: PlatformEnvVar[];
}

export interface PlatformTest {
  ok: boolean;
  state: string;
  message: string;
  /** Connected platforms: whether anyone can actually reach the bot. */
  auth_posture?: "open" | "allowlist" | "pairing" | "deny_all";
}

export interface PairingRequest {
  platform: string;
  request_id: string;
  user_id: string;
  user_name?: string;
  age_minutes?: number;
}

export interface PairedUser {
  platform: string;
  user_id: string;
  user_name?: string;
  approved_at?: number;
}

/** What a gateway restart after a quick setup did (the server tries it itself). */
export interface SetupApplied {
  ok: boolean;
  needs_restart?: boolean;
  bot_username?: string | null;
}

export interface TelegramSetup {
  pairing_id: string;
  /** Opens Telegram's BotFather flow; on the phone itself this is the whole setup. */
  deep_link: string;
  qr_payload: string;
  suggested_username?: string;
  expires_at: string;
}

export type TelegramSetupStatus =
  | { status: "waiting"; expires_at?: string }
  | { status: "ready"; bot_username?: string | null; owner_user_id?: string | null };

export interface WhatsAppSetup {
  pairing_id: string;
  status: "starting" | "waiting" | "connected" | "error" | "expired" | (string & {});
  /** Scan with WhatsApp → Linked devices. */
  qr_payload?: string | null;
  expires_at?: string;
  mode?: "bot" | "self-chat" | string;
  allowed_users?: string;
  account_name?: string | null;
  account_phone?: string | null;
  error?: string | null;
}

/** State → label and tone for a badge. */
export function platformStatus(p: MessagingPlatform): { label: string; tone: "success" | "warning" | "destructive" | "secondary" } {
  switch (p.state) {
    case "connected":
      return { label: "Conectado", tone: "success" };
    case "disabled":
      return { label: "Apagado", tone: "secondary" };
    case "not_configured":
      return { label: "Sin configurar", tone: "secondary" };
    case "pending_restart":
      return { label: "Falta reiniciar", tone: "warning" };
    case "gateway_stopped":
      return { label: "Gateway detenido", tone: "warning" };
    case "connecting":
    case "retrying":
      return { label: "Conectando", tone: "warning" };
    case "startup_failed":
    case "fatal":
      return { label: "Error", tone: "destructive" };
    default:
      return { label: p.state, tone: "secondary" };
  }
}
