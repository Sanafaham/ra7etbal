# Owner WhatsApp safe routing — deployment order

The feature flag must remain disabled while migration history and behavior are verified.

1. Reconcile migration history. The repository contains the already-applied receipt migration as `20260727_owner_whatsapp_reply_receipts.sql`, while some Supabase histories may record a longer timestamp/version. Inspect `supabase_migrations.schema_migrations` and use `supabase migration repair` to mark the existing version consistently. Do not rename, reapply, or create a second receipt table/RPC set.
2. Apply `20260728_owner_whatsapp_safe_routing_slice_1.sql`.
3. Verify existing two-argument app calls to `answer_escalation_owner_decision(token, text)` still resolve through the third parameter's `DEFAULT 'app'`.
4. Deploy the code.
5. Verify webhook, receipt, quoted-escalation, reminder, delegation, retry, and acknowledgement behavior while `OWNER_WHATSAPP_ROUTING_USER_IDS` remains empty.
6. Activate one account only after the command execution tests pass.

Rollback must run its preflight checks before any mutation. If WhatsApp reply-channel audit rows or owner-command audit rows exist, stop rather than removing evidence.
