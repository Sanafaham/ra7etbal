/**
 * Google OAuth CSRF-state storage.
 *
 * Temporary, server-only security material for the Google Calendar OAuth
 * initiation/callback flow (Carson Engineering Hardening Project,
 * Remediation 3). Deliberately kept out of `profiles` -- this data has
 * expiry and single-use semantics unrelated to durable profile state.
 *
 * A row is created only after the server has independently verified the
 * caller's Supabase JWT (see api/google-calendar.js's authenticated
 * initiation route) -- user_id is never taken from client input. Only a
 * SHA-256 hash of the random state token is stored, never the raw token.
 * The callback consumes a row with a single atomic
 * `DELETE ... WHERE state_hash = $1 AND expires_at > now() RETURNING user_id`,
 * which is inherently single-use and race-safe: concurrent deletes against
 * the same row serialize in Postgres, so only one caller can ever see a
 * returned row for a given state_hash. Deleting on consumption also means
 * successfully-used rows never accumulate; only abandoned (never-completed)
 * OAuth attempts leave a row behind, and those are opportunistically swept
 * per-user at the start of every new initiation (see the application code) --
 * bounded by GOOGLE_OAUTH_STATE_TTL_MINUTES (10) either way.
 *
 * No client role (anon/authenticated) has any access to this table --
 * REVOKE plus RLS-enabled-with-zero-policies is belt-and-suspenders: the
 * server (SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS) is the only path in.
 */

CREATE TABLE IF NOT EXISTS public.google_oauth_states (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state_hash  text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT google_oauth_states_state_hash_unique UNIQUE (state_hash)
);

REVOKE ALL ON TABLE public.google_oauth_states FROM PUBLIC, anon, authenticated;

ALTER TABLE public.google_oauth_states ENABLE ROW LEVEL SECURITY;
-- Intentionally zero policies for anon/authenticated: this table has no
-- legitimate client-facing read or write path. service_role bypasses RLS
-- and is the only writer/reader (server-side only, via api/google-calendar.js).

CREATE INDEX IF NOT EXISTS google_oauth_states_user_id_idx
  ON public.google_oauth_states (user_id);

CREATE INDEX IF NOT EXISTS google_oauth_states_expires_at_idx
  ON public.google_oauth_states (expires_at);
