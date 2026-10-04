DROP FUNCTION IF EXISTS public.finish_account_deletion_cancellation(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.claim_account_deletion_cancellation(integer);
DROP TRIGGER IF EXISTS inventory_account_deletion_inflight_work ON public.account_deletion_requests;
DROP FUNCTION IF EXISTS public.inventory_account_deletion_inflight_work();
DROP TABLE IF EXISTS public.account_deletion_work_cancellations;
