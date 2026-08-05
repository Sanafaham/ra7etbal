/**
 * One-time canonical data repair for the existing Drinking Glass
 * substitute_review created on 2026-08-04.
 *
 * This is a data repair, not a migration. It inserts only the two outbound
 * delivery records proven by immutable production database rows and Vercel
 * runtime logs from deployment dpl_zo4gFu2X8x337mMakNWp9gajDTZz
 * (SHA 58d20b9241c850e1784cf9f15599a726fbabcd2e).
 *
 * The task and owner-decision rows are locked and validated but never updated.
 */

BEGIN;

DO $repair$
DECLARE
  v_repair_id constant text := '20260806_glass_owner_review_deliveries_v1';
  v_user_id constant uuid := '645ddb96-6e09-4d91-b650-cbc75bac9a5d';
  v_task_id constant uuid := '7fdbe86c-09e5-4441-8c6a-924952d42d8c';
  v_decision_id constant uuid := 'a52dc87e-7375-4bbc-914a-d0ae3393673c';
  v_text_delivery_id constant uuid := 'd390670f-8482-4db7-93d1-eb9201a703bf';
  v_image_delivery_id constant uuid := '8fcb6807-5311-4907-bb6f-ee04d15b44d7';
  v_owner_phone constant text := '905010589614';
  v_phone_number_id constant text := '1196495893537506';
  v_text_wamid constant text := 'wamid.HBgMOTA1MDEwNTg5NjE0FQIAERgSMkZCREM3MjI0RkY2NEREQTYyAA==';
  v_image_wamid constant text := 'wamid.HBgMOTA1MDEwNTg5NjE0FQIAERgSMjhBMTE0RjMzMjg0NUI4ODBCAA==';
  v_task public.tasks;
  v_decision public.staff_escalation_owner_decisions;
  v_text public.whatsapp_deliveries;
  v_image public.whatsapp_deliveries;
  v_metadata jsonb;
  v_already_repaired boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(v_repair_id, 0));

  v_metadata := jsonb_build_object(
    'escalation_id', v_decision_id,
    'task_id', v_task_id,
    'review_type', 'substitute_review',
    'owner_phone_number_id', v_phone_number_id,
    'data_repair', jsonb_build_object(
      'id', v_repair_id,
      'reason', 'pre_workstream_2_delivery_persistence_omission',
      'evidence', 'production_database_and_vercel_runtime_logs',
      'source_deployment_id', 'dpl_zo4gFu2X8x337mMakNWp9gajDTZz',
      'source_sha', '58d20b9241c850e1784cf9f15599a726fbabcd2e'
    )
  );

  v_already_repaired :=
    EXISTS (
      SELECT 1 FROM public.whatsapp_deliveries
      WHERE id = v_text_delivery_id AND meta_message_id = v_text_wamid
    )
    AND EXISTS (
      SELECT 1 FROM public.whatsapp_deliveries
      WHERE id = v_image_delivery_id AND meta_message_id = v_image_wamid
    );

  IF NOT v_already_repaired THEN
  SELECT * INTO STRICT v_task
  FROM public.tasks
  WHERE id = v_task_id
  FOR UPDATE;

  IF v_task.user_id IS DISTINCT FROM v_user_id
     OR v_task.status IS DISTINCT FROM 'pending'
     OR v_task.assigned_to IS DISTINCT FROM 'Christopher'
     OR v_task.quality_review_status IS DISTINCT FROM 'substitute_review'
     OR v_task.description IS DISTINCT FROM
       'place one clean drinking glass on the kitchen counter and send a photo when it is done. Verification WS1-WA-20260804-2315.'
     OR v_task.proof_image_path IS DISTINCT FROM
       'task-images/645ddb96-6e09-4d91-b650-cbc75bac9a5d/7fdbe86c-09e5-4441-8c6a-924952d42d8c/proof/whatsapp-wamid.HBgLMTIwMjU2OTEzNzcVAgASGBQzQUZGMkVENjZFMkQyNjY1MkMxMwA_.jpg'
  THEN
    RAISE EXCEPTION 'repair_aborted: Glass task no longer matches immutable evidence';
  END IF;

  SELECT * INTO STRICT v_decision
  FROM public.staff_escalation_owner_decisions
  WHERE id = v_decision_id
  FOR UPDATE;

  IF v_decision.user_id IS DISTINCT FROM v_user_id
     OR v_decision.task_id IS DISTINCT FROM v_task_id
     OR v_decision.staff_message_id IS NOT NULL
     OR v_decision.review_type IS DISTINCT FROM 'substitute_review'
     OR v_decision.status IS DISTINCT FROM 'open'
     OR v_decision.owner_reply_text IS NOT NULL
     OR v_decision.answered_at IS NOT NULL
     OR v_decision.owner_notified_at IS DISTINCT FROM
       '2026-08-04T22:47:06.149Z'::timestamptz
     OR v_decision.owner_notification_status IS NOT NULL
     OR v_decision.owner_notification_meta_message_id IS NOT NULL
     OR v_decision.created_at IS DISTINCT FROM
       '2026-08-04T22:47:01.681679Z'::timestamptz
  THEN
    RAISE EXCEPTION 'repair_aborted: Glass decision no longer matches immutable legacy evidence';
  END IF;

  IF (SELECT count(*) FROM public.staff_escalation_owner_decisions
      WHERE task_id = v_task_id) <> 1 THEN
    RAISE EXCEPTION 'repair_aborted: expected exactly one Glass owner-review decision';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.whatsapp_health_state
    WHERE user_id = v_user_id
      AND phone_number_id = v_phone_number_id
      AND created_at = '2026-06-23T14:30:10.539944Z'::timestamptz
  ) THEN
    RAISE EXCEPTION 'repair_aborted: immutable business-number binding is absent';
  END IF;

  INSERT INTO public.whatsapp_deliveries (
    id, user_id, task_id, parent_delivery_id, source_type, message_kind,
    recipient_phone, recipient_name, template_name, meta_message_id,
    delivery_status, accepted_at, sent_at, delivered_at, read_at,
    last_status_at, metadata, created_at, updated_at
  ) VALUES (
    v_text_delivery_id, v_user_id, v_task_id, NULL, 'message', 'template',
    v_owner_phone, 'Owner', 'ra7etbal_direct_operational_message', v_text_wamid,
    'read',
    '2026-08-04T22:47:02.806Z'::timestamptz,
    '2026-08-04T22:47:03Z'::timestamptz,
    '2026-08-04T22:47:05Z'::timestamptz,
    '2026-08-04T22:47:14Z'::timestamptz,
    '2026-08-04T22:47:14Z'::timestamptz,
    v_metadata,
    '2026-08-04T22:47:02.806Z'::timestamptz,
    '2026-08-04T22:47:14Z'::timestamptz
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.whatsapp_deliveries (
    id, user_id, task_id, parent_delivery_id, source_type, message_kind,
    recipient_phone, recipient_name, template_name, meta_message_id,
    delivery_status, accepted_at, sent_at, delivered_at, read_at,
    last_status_at, metadata, created_at, updated_at
  ) VALUES (
    v_image_delivery_id, v_user_id, v_task_id, v_text_delivery_id,
    'image', 'image', v_owner_phone, 'Owner', NULL, v_image_wamid,
    'read',
    '2026-08-04T22:47:06.149Z'::timestamptz,
    '2026-08-04T22:47:08Z'::timestamptz,
    '2026-08-04T22:47:09Z'::timestamptz,
    '2026-08-04T22:47:14Z'::timestamptz,
    '2026-08-04T22:47:14Z'::timestamptz,
    v_metadata,
    '2026-08-04T22:47:06.149Z'::timestamptz,
    '2026-08-04T22:47:14Z'::timestamptz
  )
  ON CONFLICT DO NOTHING;
  END IF;

  SELECT * INTO STRICT v_text
  FROM public.whatsapp_deliveries
  WHERE id = v_text_delivery_id AND meta_message_id = v_text_wamid;

  SELECT * INTO STRICT v_image
  FROM public.whatsapp_deliveries
  WHERE id = v_image_delivery_id AND meta_message_id = v_image_wamid;

  IF v_text.user_id IS DISTINCT FROM v_user_id
     OR v_text.task_id IS DISTINCT FROM v_task_id
     OR v_text.parent_delivery_id IS NOT NULL
     OR v_text.source_type IS DISTINCT FROM 'message'
     OR v_text.message_kind IS DISTINCT FROM 'template'
     OR v_text.recipient_phone IS DISTINCT FROM v_owner_phone
     OR v_text.recipient_name IS DISTINCT FROM 'Owner'
     OR v_text.template_name IS DISTINCT FROM 'ra7etbal_direct_operational_message'
     OR v_text.delivery_status IS DISTINCT FROM 'read'
     OR v_text.accepted_at IS DISTINCT FROM '2026-08-04T22:47:02.806Z'::timestamptz
     OR v_text.sent_at IS DISTINCT FROM '2026-08-04T22:47:03Z'::timestamptz
     OR v_text.delivered_at IS DISTINCT FROM '2026-08-04T22:47:05Z'::timestamptz
     OR v_text.read_at IS DISTINCT FROM '2026-08-04T22:47:14Z'::timestamptz
     OR v_text.last_status_at IS DISTINCT FROM '2026-08-04T22:47:14Z'::timestamptz
     OR v_text.created_at IS DISTINCT FROM '2026-08-04T22:47:02.806Z'::timestamptz
     OR v_text.updated_at IS DISTINCT FROM '2026-08-04T22:47:14Z'::timestamptz
     OR v_text.metadata IS DISTINCT FROM v_metadata
     OR v_image.user_id IS DISTINCT FROM v_user_id
     OR v_image.task_id IS DISTINCT FROM v_task_id
     OR v_image.parent_delivery_id IS DISTINCT FROM v_text_delivery_id
     OR v_image.source_type IS DISTINCT FROM 'image'
     OR v_image.message_kind IS DISTINCT FROM 'image'
     OR v_image.recipient_phone IS DISTINCT FROM v_owner_phone
     OR v_image.recipient_name IS DISTINCT FROM 'Owner'
     OR v_image.template_name IS NOT NULL
     OR v_image.delivery_status IS DISTINCT FROM 'read'
     OR v_image.accepted_at IS DISTINCT FROM '2026-08-04T22:47:06.149Z'::timestamptz
     OR v_image.sent_at IS DISTINCT FROM '2026-08-04T22:47:08Z'::timestamptz
     OR v_image.delivered_at IS DISTINCT FROM '2026-08-04T22:47:09Z'::timestamptz
     OR v_image.read_at IS DISTINCT FROM '2026-08-04T22:47:14Z'::timestamptz
     OR v_image.last_status_at IS DISTINCT FROM '2026-08-04T22:47:14Z'::timestamptz
     OR v_image.created_at IS DISTINCT FROM '2026-08-04T22:47:06.149Z'::timestamptz
     OR v_image.updated_at IS DISTINCT FROM '2026-08-04T22:47:14Z'::timestamptz
     OR v_image.metadata IS DISTINCT FROM v_metadata
  THEN
    RAISE EXCEPTION 'repair_aborted: existing or inserted delivery rows do not match the repair contract';
  END IF;
END
$repair$;

COMMIT;

SELECT
  id,
  task_id,
  parent_delivery_id,
  source_type,
  message_kind,
  recipient_phone,
  recipient_name,
  meta_message_id,
  delivery_status,
  accepted_at,
  sent_at,
  delivered_at,
  read_at,
  metadata
FROM public.whatsapp_deliveries
WHERE id IN (
  'd390670f-8482-4db7-93d1-eb9201a703bf'::uuid,
  '8fcb6807-5311-4907-bb6f-ee04d15b44d7'::uuid
)
ORDER BY created_at;
