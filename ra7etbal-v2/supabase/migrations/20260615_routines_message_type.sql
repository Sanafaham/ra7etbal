/**
 * Extend routines.type to include 'message'.
 *
 * 'message' routines send a plain WhatsApp message verbatim to a person
 * on a schedule — no task creation, no confirmation link.
 *
 * payload shape: { "person_id": "<uuid>", "message": "<exact text>" }
 *
 * The existing 'reminder' and 'delegation' constraint names may differ
 * per environment, so we use DROP CONSTRAINT IF EXISTS by name then re-add.
 */

ALTER TABLE public.routines
  DROP CONSTRAINT IF EXISTS routines_type_check;

ALTER TABLE public.routines
  ADD CONSTRAINT routines_type_check
    CHECK (type IN ('reminder', 'delegation', 'message'));
