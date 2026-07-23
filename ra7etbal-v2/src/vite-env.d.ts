/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_VAPID_PUBLIC_KEY: string;
  readonly VITE_ELEVENLABS_AGENT_ID?: string;
  /** E.164 phone number for Carson's WhatsApp conversation, e.g. +971501234567. */
  readonly VITE_CARSON_WHATSAPP_NUMBER?: string;
  /** Set to "true" to show the WhatsApp channel option (also requires VITE_CARSON_WHATSAPP_NUMBER). */
  readonly VITE_ENABLE_CARSON_WHATSAPP?: string;
  /** E.164 phone number to call for Carson, e.g. +971501234567. */
  readonly VITE_CARSON_PHONE_NUMBER?: string;
  /** Set to "true" to show the Call Carson channel option (also requires VITE_CARSON_PHONE_NUMBER). */
  readonly VITE_ENABLE_CARSON_CALL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
