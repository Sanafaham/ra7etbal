/**
 * Owner WhatsApp canonical binding — database-enforced invariant.
 *
 * Incident (2026-08-11/12): recordWebhookHeartbeat() (api/whatsapp-webhook.js)
 * had a bug that could bind unrelated Supabase accounts to the one real
 * production WhatsApp Business phone_number_id, breaking
 * resolveCanonicalOwner()'s "exactly one account per number" assumption and
 * silently degrading owner-reply routing for a full day with no error
 * signal. The application-level fix removes the code path that could ever
 * invent such a binding; this migration adds the matching database
 * invariant so a similar bug class can never again write bad data, even if
 * a future code path gets this wrong.
 *
 * Verified before writing this migration: this product's architecture has
 * exactly one canonical account per WhatsApp Business phone_number_id
 * (resolveCanonicalOwner's own account_not_unique branch treats more than
 * one as a hard, never-expected failure) -- no legitimate multi-account
 * sharing of one number exists anywhere in this codebase. A read-only
 * preflight against production confirmed exactly one phone_number_id
 * currently has more than one bound account (the two proven phantom rows
 * from the incident above); no other unexpected contamination was found.
 *
 * The existing UNIQUE (user_id, phone_number_id) constraint only prevents
 * duplicate rows for the *same* user -- it does nothing to prevent two
 * *different* users from each getting their own row on the same number.
 * This adds the stricter invariant additively, without touching the
 * existing constraint.
 *
 * Must be applied AFTER the phantom rows are deleted (see the companion
 * data-repair file) -- while they still exist, this ALTER TABLE would
 * correctly fail rather than silently succeed on bad data.
 *
 * Table is small (per-account health bookkeeping rows, not a hot
 * high-volume table), so a plain ADD CONSTRAINT UNIQUE (a brief
 * ACCESS EXCLUSIVE lock while Postgres builds the backing unique index) is
 * safe and proportionate -- no CONCURRENTLY-index dance needed.
 */

ALTER TABLE public.whatsapp_health_state
  ADD CONSTRAINT whatsapp_health_state_phone_number_id_unique UNIQUE (phone_number_id);
