\set ON_ERROR_STOP on
DO $$
DECLARE
  a uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  b uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  request_a uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  claim1 record; claim2 record; claim3 record; table_name text; n integer; b_insert uuid;
BEGIN
  INSERT INTO auth.users VALUES (a), (b);
  INSERT INTO public.profiles VALUES (a, 'retain-for-provider-revocation'), (b, 'b-token');
  INSERT INTO public.people(user_id) VALUES (a), (b);
  INSERT INTO public.whatsapp_consent_log(user_id) VALUES (a), (b);
  INSERT INTO public.whatsapp_inbound_evidence(sender_phone) VALUES ('unattributed');

  FOREACH table_name IN ARRAY ARRAY[
    'carson_facts','carson_memory','carson_notes','carson_pending_operations',
    'carson_persistent_memory','carson_todos','carson_tool_diagnostics','automations',
    'automation_runs','reminder_delivery_events','routines','owner_notifications',
    'push_subscriptions','google_oauth_states','household_rules','inbox_items',
    'clear_my_head_inbox','owner_whatsapp_reply_receipts','personal_contact_replies',
    'quality_substitute_decisions','staff_messages'
  ] LOOP
    EXECUTE format('INSERT INTO public.%I(user_id) VALUES ($1), ($2)', table_name) USING a, b;
  END LOOP;
  INSERT INTO public.carson_typed_messages(user_id, elevenlabs_conversation_id) VALUES (a,'conv-a'),(b,'conv-b');
  INSERT INTO public.tasks(user_id,image_path,proof_image_path) VALUES (a,'a/image.jpg','a/proof.jpg'),(b,'b/image.jpg','b/proof.jpg');
  INSERT INTO public.task_attachments(user_id,storage_path) VALUES (a,'a/file.pdf'),(b,'b/file.pdf');
  INSERT INTO public.messages(user_id,whatsapp_message_id) VALUES (a,'wamid-a'),(b,'wamid-b');
  INSERT INTO public.whatsapp_deliveries(user_id,meta_message_id) VALUES (a,'delivery-a'),(b,'delivery-b');
  INSERT INTO public.whatsapp_health_state(user_id,phone_number_id) VALUES (a,'phone-a'),(b,'phone-b');
  INSERT INTO public.staff_escalation_owner_decisions(user_id,proposed_photo_path) VALUES (a,'a/proposed.jpg'),(b,'b/proposed.jpg');
  INSERT INTO public.account_deletion_requests(id,user_id) VALUES (request_a,a);
  INSERT INTO public.account_deletion_work_cancellations(request_id,status) VALUES (request_a,'locally_invalidated');

  SELECT * INTO claim1 FROM public.claim_account_deletion_relational(120);
  IF claim1.request_id <> request_a THEN RAISE EXCEPTION 'wrong request claimed'; END IF;
  SELECT * INTO claim2 FROM public.claim_account_deletion_relational(120);
  IF claim2.request_id IS NOT NULL THEN RAISE EXCEPTION 'concurrent duplicate claim succeeded'; END IF;
  IF NOT public.fail_account_deletion_relational(request_a,claim1.lease_token,'fixture_retry',false) THEN
    RAISE EXCEPTION 'lease-fenced failure transition failed';
  END IF;
  SELECT * INTO claim3 FROM public.claim_account_deletion_relational(120);
  IF claim3.request_id <> request_a THEN RAISE EXCEPTION 'retry did not reclaim'; END IF;
  IF NOT public.execute_account_deletion_relational(request_a,claim3.lease_token) THEN
    RAISE EXCEPTION 'execution did not complete';
  END IF;
  IF public.execute_account_deletion_relational(request_a,claim3.lease_token) THEN
    RAISE EXCEPTION 'completed stage executed twice';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'carson_facts','carson_memory','carson_notes','carson_pending_operations',
    'carson_persistent_memory','carson_todos','carson_tool_diagnostics','carson_typed_messages',
    'tasks','task_attachments','messages','staff_messages','staff_escalation_owner_decisions',
    'quality_substitute_decisions','owner_whatsapp_reply_receipts','personal_contact_replies',
    'whatsapp_deliveries','whatsapp_health_state','automations','automation_runs',
    'reminder_delivery_events','routines','owner_notifications','push_subscriptions',
    'google_oauth_states','household_rules','inbox_items','clear_my_head_inbox'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1',table_name) INTO n USING a;
    IF n <> 0 THEN RAISE EXCEPTION 'Account A survived in %', table_name; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1',table_name) INTO n USING b;
    IF n <> 1 THEN RAISE EXCEPTION 'Account B damaged in %', table_name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.account_deletion_cleanup_references WHERE request_id=request_a) <> 8 THEN
    RAISE EXCEPTION 'later-stage correlation incomplete';
  END IF;
  IF (SELECT count(*) FROM public.account_deletion_resource_results WHERE request_id=request_a) <> 8 THEN
    RAISE EXCEPTION 'resource evidence incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.people WHERE user_id=a)
    OR NOT EXISTS (SELECT 1 FROM public.whatsapp_consent_log WHERE user_id=a)
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=a)
    OR (SELECT count(*) FROM public.whatsapp_inbound_evidence) <> 1 THEN
    RAISE EXCEPTION 'later/blocked resource was deleted';
  END IF;
  INSERT INTO public.carson_memory(user_id) VALUES (b) RETURNING id INTO b_insert;
  IF b_insert IS NULL OR (SELECT count(*) FROM public.carson_memory WHERE user_id=b) <> 2 THEN
    RAISE EXCEPTION 'Account B is not operational after Account A deletion';
  END IF;
  BEGIN
    INSERT INTO public.carson_memory(user_id) VALUES (a);
    RAISE EXCEPTION 'stale memory recreation was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

DO $$ BEGIN
  IF has_function_privilege('anon','public.execute_account_deletion_relational(uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.execute_account_deletion_relational(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'unprivileged role can execute destructive RPC';
  END IF;
END $$;
