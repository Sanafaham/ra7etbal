/**
 * Rollback for 20260710_quality_substitute_review.sql
 *
 * Not part of the normal migration run — kept as a companion reference and
 * applied manually only if Phase 8.1 needs to be reverted. Order matters:
 * stray 'substitute_review' rows must be remediated to 'uncertain' (the
 * existing owner-fallback state) BEFORE the original, narrower CHECK
 * constraint is restored, or that step fails outright.
 */

DROP FUNCTION IF EXISTS public.complete_custom_instruction(uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.complete_rejected_alternative(uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.complete_approved_alternative(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.reserve_send_window(uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.claim_substitute_decision(uuid, uuid, text, timestamptz, text, text, text);

DROP TABLE IF EXISTS public.quality_substitute_decisions;

ALTER TABLE public.tasks DROP COLUMN IF EXISTS worker_reply;

UPDATE public.tasks SET quality_review_status = 'uncertain' WHERE quality_review_status = 'substitute_review';

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_quality_review_status_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_quality_review_status_check
  CHECK (quality_review_status = ANY (ARRAY[
    'approved'::text,
    'correction_required'::text,
    'uncertain'::text,
    'fraud_suspected'::text
  ]));
