BEGIN;

CREATE FUNCTION public.reclaim_staff_evidence_message(
  p_id                  uuid,
  p_user_id             uuid,
  p_expected_updated_at timestamptz
)
RETURNS TABLE (
  message_id        uuid,
  acquired          boolean,
  processing_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current public.staff_messages;
  v_row     public.staff_messages;
BEGIN
  IF p_id IS NULL OR p_user_id IS NULL OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'missing_reclaim_context'
      USING ERRCODE = '22023';
  END IF;

  SELECT sm.*
  INTO v_current
  FROM public.staff_messages AS sm
  WHERE sm.id = p_id
    AND sm.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized'
      USING ERRCODE = '28000';
  END IF;

  -- This RPC is an internal concurrency primitive for WhatsApp photo
  -- evidence. It never decides or changes task/business state.
  IF v_current.source <> 'whatsapp'
     OR v_current.external_message_id IS NULL
     OR v_current.inbound_text NOT LIKE '[Photo evidence]%' THEN
    RAISE EXCEPTION 'not_staff_evidence'
      USING ERRCODE = '22023';
  END IF;

  -- Completed evidence is terminal and is never reclaimed.
  IF v_current.processing_status = 'completed' THEN
    RETURN QUERY
      SELECT v_current.id, false, v_current.processing_status;
    RETURN;
  END IF;

  -- Fence the processing generation observed by the caller.
  IF v_current.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN QUERY
      SELECT v_current.id, false, v_current.processing_status;
    RETURN;
  END IF;

  IF v_current.processing_status = 'claimed' THEN
    -- task-confirm and Quality Intelligence run inside a 60-second function
    -- window. Claims newer than two minutes remain owned and cannot be stolen.
    IF v_current.updated_at > now() - interval '120 seconds' THEN
      RETURN QUERY
        SELECT v_current.id, false, v_current.processing_status;
      RETURN;
    END IF;
  ELSIF v_current.processing_status <> 'failed' THEN
    RAISE EXCEPTION 'invalid_transition'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_messages AS sm
  SET
    processing_status = 'claimed',
    processing_error = NULL
  WHERE sm.id = v_current.id
    AND sm.user_id = p_user_id
    AND sm.updated_at = p_expected_updated_at
    AND sm.processing_status IN ('claimed', 'failed')
  RETURNING sm.*
  INTO v_row;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT v_current.id, false, v_current.processing_status;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT v_row.id, true, v_row.processing_status;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  public.reclaim_staff_evidence_message(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.reclaim_staff_evidence_message(uuid, uuid, timestamptz)
  TO service_role;

COMMIT;
