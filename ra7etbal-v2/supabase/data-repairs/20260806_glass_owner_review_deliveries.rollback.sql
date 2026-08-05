/**
 * Rollback for 20260806_glass_owner_review_deliveries.sql.
 *
 * This rollback is intentionally allowed only before the repaired quoted
 * identity has been consumed. Once an owner reply references the repaired
 * WAMID, deleting canonical evidence would destroy audit history, so the
 * rollback fails closed.
 */

BEGIN;

DO $rollback$
DECLARE
  v_repair_id constant text := '20260806_glass_owner_review_deliveries_v1';
  v_task_id constant uuid := '7fdbe86c-09e5-4441-8c6a-924952d42d8c';
  v_decision_id constant uuid := 'a52dc87e-7375-4bbc-914a-d0ae3393673c';
  v_text_delivery_id constant uuid := 'd390670f-8482-4db7-93d1-eb9201a703bf';
  v_image_delivery_id constant uuid := '8fcb6807-5311-4907-bb6f-ee04d15b44d7';
  v_text_wamid constant text := 'wamid.HBgMOTA1MDEwNTg5NjE0FQIAERgSMkZCREM3MjI0RkY2NEREQTYyAA==';
  v_image_wamid constant text := 'wamid.HBgMOTA1MDEwNTg5NjE0FQIAERgSMjhBMTE0RjMzMjg0NUI4ODBCAA==';
  v_decision public.staff_escalation_owner_decisions;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(v_repair_id, 0));

  SELECT * INTO STRICT v_decision
  FROM public.staff_escalation_owner_decisions
  WHERE id = v_decision_id
  FOR UPDATE;

  IF v_decision.task_id IS DISTINCT FROM v_task_id
     OR v_decision.status IS DISTINCT FROM 'open'
     OR v_decision.owner_reply_text IS NOT NULL
     OR v_decision.answered_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'rollback_aborted: repaired identity may already have been consumed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.owner_whatsapp_reply_receipts
    WHERE context_message_id IN (v_text_wamid, v_image_wamid)
  ) THEN
    RAISE EXCEPTION 'rollback_aborted: an inbound owner reply references repaired evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.whatsapp_deliveries
    WHERE id IN (v_text_delivery_id, v_image_delivery_id)
      AND (
        meta_message_id NOT IN (v_text_wamid, v_image_wamid)
        OR metadata #>> '{data_repair,id}' IS DISTINCT FROM v_repair_id
      )
  ) THEN
    RAISE EXCEPTION 'rollback_aborted: target rows do not match the repair provenance';
  END IF;

  DELETE FROM public.whatsapp_deliveries
  WHERE id = v_image_delivery_id
    AND meta_message_id = v_image_wamid
    AND metadata #>> '{data_repair,id}' = v_repair_id;

  DELETE FROM public.whatsapp_deliveries
  WHERE id = v_text_delivery_id
    AND meta_message_id = v_text_wamid
    AND metadata #>> '{data_repair,id}' = v_repair_id;

  IF EXISTS (
    SELECT 1 FROM public.whatsapp_deliveries
    WHERE id IN (v_text_delivery_id, v_image_delivery_id)
       OR meta_message_id IN (v_text_wamid, v_image_wamid)
  ) THEN
    RAISE EXCEPTION 'rollback_aborted: repaired delivery evidence remains';
  END IF;
END
$rollback$;

COMMIT;
