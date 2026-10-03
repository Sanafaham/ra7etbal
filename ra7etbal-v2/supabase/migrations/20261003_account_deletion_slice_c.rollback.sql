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
    EXECUTE format('DROP TRIGGER IF EXISTS reject_frozen_account_owned_data_insert ON public.%I', t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.reject_frozen_account_owned_data_insert();
DROP FUNCTION IF EXISTS public.fail_account_deletion_relational(uuid, uuid, text, boolean);
DROP FUNCTION IF EXISTS public.execute_account_deletion_relational(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_account_deletion_relational(integer);
DROP TABLE IF EXISTS public.account_deletion_cleanup_references;
DROP TABLE IF EXISTS public.account_deletion_resource_results;
DROP INDEX IF EXISTS public.account_deletion_relational_claim_idx;
ALTER TABLE public.account_deletion_requests
  DROP CONSTRAINT IF EXISTS account_deletion_relational_failure_code_check,
  DROP CONSTRAINT IF EXISTS account_deletion_relational_completed_check,
  DROP COLUMN IF EXISTS relational_deletion_lease_expires_at,
  DROP COLUMN IF EXISTS relational_deletion_lease_token,
  DROP COLUMN IF EXISTS relational_deletion_failure_code,
  DROP COLUMN IF EXISTS relational_deletion_completed_at,
  DROP COLUMN IF EXISTS relational_deletion_started_at,
  DROP COLUMN IF EXISTS relational_deletion_status;
