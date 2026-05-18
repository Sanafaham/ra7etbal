import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Set them in .env.local (dev) and on Vercel (preview + production).",
  );
}

declare global {
  // Survives Vite HMR module re-evaluation so we never end up with two clients.
  // eslint-disable-next-line no-var
  var __ra7etbal_supabase: SupabaseClient | undefined;
}

export const supabase: SupabaseClient =
  globalThis.__ra7etbal_supabase ??
  createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      storageKey: "ra7etbal-v2.auth",
    },
  });

if (!globalThis.__ra7etbal_supabase) {
  globalThis.__ra7etbal_supabase = supabase;
}
