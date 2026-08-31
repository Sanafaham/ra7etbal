import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Non-null when this build is missing VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY
 * (e.g. an isolated preview/proof deployment that doesn't carry the full set
 * of production frontend env vars). main.tsx checks this AFTER the module
 * graph below has finished loading and renders a visible diagnostic instead
 * of the app — never a blank white page. This module intentionally does NOT
 * throw here: lib/session.ts imports `supabase` and calls
 * `supabase.auth.onAuthStateChange(...)` synchronously at import time with
 * no awaitable boundary (see that file's comment) — a throw here would still
 * crash the whole module graph before main.tsx gets a chance to react, so a
 * placeholder client is constructed instead to keep that import chain intact.
 */
export const supabaseConfigError: string | null =
  !url || !anonKey
    ? "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Set them in .env.local (dev) and on Vercel (preview + production)."
    : null;

declare global {
  // Survives Vite HMR module re-evaluation so we never end up with two clients.
  // eslint-disable-next-line no-var
  var __ra7etbal_supabase: SupabaseClient | undefined;
}

export const supabase: SupabaseClient =
  globalThis.__ra7etbal_supabase ??
  createClient(url || "http://127.0.0.1:1", anonKey || "placeholder-anon-key", {
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
