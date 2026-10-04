-- Phase 3G / Slice C: bounded owner-relational and Carson-memory deletion.
-- This migration does not delete Auth identities, Storage objects, provider
-- data, consent evidence, People, profiles, or unattributed inbound evidence.

ALTER TABLE public.account_deletion_requests
  ADD COLUMN relational_deletion_status text NOT NULL DEFAULT 'not_started'
    CHECK (relational_deletion_status IN (
      'not_started', 'in_progress', 'completed', 'failed_retryable',
      'failed_requires_review', 'blocked'
    )),
  ADD COLUMN relational_deletion_started_at timestamptz,
  ADD COLUMN relational_deletion_completed_at timestamptz,
  ADD COLUMN relational_deletion_failure_code text,
  ADD COLUMN relational_deletion_lease_token uuid,
  ADD COLUMN relational_deletion_lease_expires_at timestamptz,
  ADD CONSTRAINT account_deletion_relational_completed_check CHECK (
    (relational_deletion_status = 'completed') =
    (relational_deletion_completed_at IS NOT NULL)
  ),
  ADD CONSTRAINT account_deletion_relational_failure_code_check CHECK (
    relational_deletion_failure_code IS NULL OR
    relational_deletion_failure_code ~ '^[a-z0-9_]{1,80}$'
  );

CREATE TABLE public.account_deletion_resource_results (
  request_id uuid NOT NULL REFERENCES public.account_deletion_requests(id) ON DELETE CASCADE,
  resource_class text NOT NULL CHECK (resource_class IN (
    'carson_memory', 'operational_data', 'communication_data',
    'notification_and_preferences', 'people_and_consent',
    'provider_credentials', 'storage_objects', 'whatsapp_inbound_evidence'
  )),
  disposition text NOT NULL CHECK (disposition IN (
    'deleted', 'already_absent', 'retained_for_later', 'blocked',
    'failed_requires_review', 'not_applicable'
  )),
  affected_count integer CHECK (affected_count IS NULL OR affected_count >= 0),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,80}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, resource_class)
);

ALTER TABLE public.account_deletion_resource_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "account deletion resources: owner can read"
  ON public.account_deletion_resource_results FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.account_deletion_requests r
    WHERE r.id = request_id AND r.user_id = auth.uid()
  ));
REVOKE ALL ON public.account_deletion_resource_results FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_deletion_resource_results TO authenticated;
GRANT ALL ON public.account_deletion_resource_results TO service_role;

-- Service-only, content-free correlation needed by later Storage/provider slices.
CREATE TABLE public.account_deletion_cleanup_references (
  request_id uuid NOT NULL REFERENCES public.account_deletion_requests(id) ON DELETE CASCADE,
  reference_kind text NOT NULL CHECK (reference_kind IN (
    'storage_object', 'whatsapp_message', 'elevenlabs_conversation',
    'provider_phone_number'
  )),
  source_table text NOT NULL CHECK (source_table ~ '^[a-z0-9_]{1,80}$'),
  source_row_id text NOT NULL,
  external_reference text NOT NULL CHECK (length(external_reference) BETWEEN 1 AND 2048),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, reference_kind, source_table, source_row_id, external_reference)
);
ALTER TABLE public.account_deletion_cleanup_references ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_cleanup_references FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.account_deletion_cleanup_references TO service_role;

CREATE INDEX account_deletion_relational_claim_idx
  ON public.account_deletion_requests (relational_deletion_lease_expires_at, requested_at)
  WHERE relational_deletion_status IN ('not_started', 'in_progress', 'failed_retryable');

CREATE OR REPLACE FUNCTION public.claim_account_deletion_relational(p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (request_id uuid, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_request_id uuid; v_token uuid := gen_random_uuid();
BEGIN
  SELECT r.id INTO v_request_id
  FROM public.account_deletion_requests r
  WHERE r.status IN ('in_progress', 'failed_retryable', 'failed_requires_review')
    AND r.user_id IS NOT NULL
    AND r.relational_deletion_status IN ('not_started', 'in_progress', 'failed_retryable')
    AND (r.relational_deletion_status <> 'in_progress'
      OR r.relational_deletion_lease_expires_at <= now())
    AND NOT EXISTS (
      SELECT 1 FROM public.account_deletion_work_cancellations c
      WHERE c.request_id = r.id AND c.status IN (
        'external_cancellation_pending', 'external_cancellation_attempted',
        'external_outcome_unknown', 'failed_retryable'
      )
    )
  ORDER BY r.requested_at, r.id
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_request_id IS NULL THEN RETURN; END IF;
  UPDATE public.account_deletion_requests r
  SET relational_deletion_status = 'in_progress',
      relational_deletion_started_at = COALESCE(r.relational_deletion_started_at, now()),
      relational_deletion_failure_code = NULL,
      relational_deletion_lease_token = v_token,
      relational_deletion_lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 600))),
      updated_at = now()
  WHERE r.id = v_request_id;
  RETURN QUERY SELECT v_request_id, v_token;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_account_deletion_relational(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_deletion_relational(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.execute_account_deletion_relational(
  p_request_id uuid, p_lease_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user_id uuid; v_count integer; v_carson integer := 0; v_ops integer := 0;
  v_comms integer := 0; v_misc integer := 0;
BEGIN
  SELECT r.user_id INTO v_user_id
  FROM public.account_deletion_requests r
  WHERE r.id = p_request_id AND r.relational_deletion_status = 'in_progress'
    AND r.relational_deletion_lease_token = p_lease_token
    AND r.relational_deletion_lease_expires_at > now()
  FOR UPDATE;
  IF v_user_id IS NULL THEN RETURN false; END IF;

  -- Capture identifiers only; never copy message, task, contact, or memory content.
  INSERT INTO public.account_deletion_cleanup_references
    (request_id, reference_kind, source_table, source_row_id, external_reference)
  SELECT p_request_id, 'storage_object', 'task_attachments', a.id::text, a.storage_path
  FROM public.task_attachments a WHERE a.user_id = v_user_id AND a.storage_path IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO public.account_deletion_cleanup_references
  SELECT p_request_id, 'storage_object', 'tasks', t.id::text || ':image', t.image_path, now()
  FROM public.tasks t WHERE t.user_id = v_user_id AND t.image_path IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO public.account_deletion_cleanup_references
  SELECT p_request_id, 'storage_object', 'tasks', t.id::text || ':proof', t.proof_image_path, now()
  FROM public.tasks t WHERE t.user_id = v_user_id AND t.proof_image_path IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO public.account_deletion_cleanup_references
  SELECT p_request_id, 'storage_object', 'staff_escalation_owner_decisions', d.id::text, d.proposed_photo_path, now()
  FROM public.staff_escalation_owner_decisions d
  WHERE d.user_id = v_user_id AND d.proposed_photo_path IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO public.account_deletion_cleanup_references
  SELECT p_request_id, 'whatsapp_message', 'messages', m.id::text, m.whatsapp_message_id, now()
  FROM public.messages m WHERE m.user_id = v_user_id AND m.whatsapp_message_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO public.account_deletion_cleanup_references
  SELECT p_request_id, 'whatsapp_message', 'whatsapp_deliveries', d.id::text, d.meta_message_id, now()
  FROM public.whatsapp_deliveries d WHERE d.user_id = v_user_id AND d.meta_message_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO public.account_deletion_cleanup_references
  SELECT p_request_id, 'elevenlabs_conversation', 'carson_typed_messages', m.id::text, m.elevenlabs_conversation_id, now()
  FROM public.carson_typed_messages m
  WHERE m.user_id = v_user_id AND m.elevenlabs_conversation_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO public.account_deletion_cleanup_references
  SELECT p_request_id, 'provider_phone_number', 'whatsapp_health_state', h.id::text, h.phone_number_id, now()
  FROM public.whatsapp_health_state h WHERE h.user_id = v_user_id AND h.phone_number_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  DELETE FROM public.carson_tool_diagnostics WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_carson := v_carson + v_count;
  DELETE FROM public.carson_typed_messages WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_carson := v_carson + v_count;
  DELETE FROM public.carson_pending_operations WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_carson := v_carson + v_count;
  DELETE FROM public.carson_notes WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_carson := v_carson + v_count;
  DELETE FROM public.carson_todos WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_carson := v_carson + v_count;
  DELETE FROM public.carson_facts WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_carson := v_carson + v_count;
  DELETE FROM public.carson_persistent_memory WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_carson := v_carson + v_count;
  DELETE FROM public.carson_memory WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_carson := v_carson + v_count;

  DELETE FROM public.owner_whatsapp_reply_receipts WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_comms := v_comms + v_count;
  DELETE FROM public.personal_contact_replies WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_comms := v_comms + v_count;
  DELETE FROM public.quality_substitute_decisions WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_comms := v_comms + v_count;
  DELETE FROM public.staff_escalation_owner_decisions WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_comms := v_comms + v_count;
  DELETE FROM public.staff_messages WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_comms := v_comms + v_count;
  DELETE FROM public.whatsapp_deliveries WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_comms := v_comms + v_count;
  DELETE FROM public.messages WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_comms := v_comms + v_count;

  DELETE FROM public.reminder_delivery_events WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_ops := v_ops + v_count;
  DELETE FROM public.automation_runs WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_ops := v_ops + v_count;
  DELETE FROM public.automations WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_ops := v_ops + v_count;
  DELETE FROM public.task_attachments WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_ops := v_ops + v_count;
  DELETE FROM public.tasks WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_ops := v_ops + v_count;
  DELETE FROM public.routines WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_ops := v_ops + v_count;

  DELETE FROM public.owner_notifications WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_misc := v_misc + v_count;
  DELETE FROM public.push_subscriptions WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_misc := v_misc + v_count;
  DELETE FROM public.google_oauth_states WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_misc := v_misc + v_count;
  DELETE FROM public.household_rules WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_misc := v_misc + v_count;
  DELETE FROM public.inbox_items WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_misc := v_misc + v_count;
  DELETE FROM public.clear_my_head_inbox WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_misc := v_misc + v_count;
  DELETE FROM public.whatsapp_health_state WHERE user_id = v_user_id; GET DIAGNOSTICS v_count = ROW_COUNT; v_misc := v_misc + v_count;

  INSERT INTO public.account_deletion_resource_results VALUES
    (p_request_id, 'carson_memory', CASE WHEN v_carson=0 THEN 'already_absent' ELSE 'deleted' END, v_carson, NULL, now()),
    (p_request_id, 'operational_data', CASE WHEN v_ops=0 THEN 'already_absent' ELSE 'deleted' END, v_ops, NULL, now()),
    (p_request_id, 'communication_data', CASE WHEN v_comms=0 THEN 'already_absent' ELSE 'deleted' END, v_comms, NULL, now()),
    (p_request_id, 'notification_and_preferences', CASE WHEN v_misc=0 THEN 'already_absent' ELSE 'deleted' END, v_misc, NULL, now()),
    (p_request_id, 'people_and_consent', 'retained_for_later', NULL, 'legal_policy_decision_required', now()),
    (p_request_id, 'provider_credentials', 'retained_for_later', NULL, 'provider_revocation_required', now()),
    (p_request_id, 'storage_objects', 'retained_for_later', NULL, 'storage_deletion_not_authorized', now()),
    (p_request_id, 'whatsapp_inbound_evidence', 'blocked', NULL, 'ownership_retention_policy_required', now())
  ON CONFLICT (request_id, resource_class) DO UPDATE SET
    disposition=EXCLUDED.disposition, affected_count=EXCLUDED.affected_count,
    failure_code=EXCLUDED.failure_code, recorded_at=EXCLUDED.recorded_at;

  UPDATE public.account_deletion_requests SET
    relational_deletion_status='completed', relational_deletion_completed_at=now(),
    relational_deletion_failure_code=NULL, relational_deletion_lease_token=NULL,
    relational_deletion_lease_expires_at=NULL, updated_at=now()
  WHERE id=p_request_id AND relational_deletion_lease_token=p_lease_token;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.execute_account_deletion_relational(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_account_deletion_relational(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fail_account_deletion_relational(
  p_request_id uuid, p_lease_token uuid, p_failure_code text,
  p_requires_review boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_updated integer;
BEGIN
  IF p_failure_code IS NULL OR p_failure_code !~ '^[a-z0-9_]{1,80}$' THEN
    RAISE EXCEPTION 'invalid_failure_code' USING ERRCODE = '22023';
  END IF;
  UPDATE public.account_deletion_requests SET
    relational_deletion_status=CASE WHEN p_requires_review THEN 'failed_requires_review' ELSE 'failed_retryable' END,
    relational_deletion_failure_code=p_failure_code,
    relational_deletion_lease_token=NULL, relational_deletion_lease_expires_at=NULL,
    updated_at=now()
  WHERE id=p_request_id AND relational_deletion_status='in_progress'
    AND relational_deletion_lease_token=p_lease_token;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.fail_account_deletion_relational(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_account_deletion_relational(uuid, uuid, text, boolean) TO service_role;

-- Frozen accounts cannot be repopulated by late jobs/callbacks after Slice C.
CREATE OR REPLACE FUNCTION public.reject_frozen_account_owned_data_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF public.account_deletion_is_frozen(NEW.user_id) THEN
    RAISE EXCEPTION 'account_deletion_in_progress' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_frozen_account_owned_data_insert() FROM PUBLIC, anon, authenticated;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'carson_facts','carson_memory','carson_notes','carson_pending_operations',
    'carson_persistent_memory','carson_todos','carson_tool_diagnostics',
    'carson_typed_messages','automation_runs','clear_my_head_inbox','google_oauth_states',
    'household_rules','inbox_items','owner_notifications','owner_whatsapp_reply_receipts',
    'personal_contact_replies','push_subscriptions','quality_substitute_decisions',
    'reminder_delivery_events','staff_escalation_owner_decisions','staff_messages',
    'task_attachments','whatsapp_deliveries','whatsapp_health_state'
  ] LOOP
    EXECUTE format('CREATE TRIGGER reject_frozen_account_owned_data_insert BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_frozen_account_owned_data_insert()', t);
  END LOOP;
END $$;
