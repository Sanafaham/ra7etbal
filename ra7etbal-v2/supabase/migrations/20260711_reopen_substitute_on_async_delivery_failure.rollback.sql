/**
 * Rollback for 20260711_reopen_substitute_on_async_delivery_failure.sql
 *
 * Purely a new function — no table/column/constraint changes to undo.
 */

drop function if exists public.reopen_substitute_decision_on_delivery_failure(uuid);
