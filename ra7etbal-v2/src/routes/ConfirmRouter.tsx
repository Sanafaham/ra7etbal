import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Spinner from "../components/Spinner";
import Confirm from "./Confirm";
import OwnerEscalationDecision from "./OwnerEscalationDecision";

export type ConfirmLinkKind = "task" | "owner_escalation";

/**
 * Phase C — preserves the approved Meta template URL shape
 * (https://www.ra7etbal.com/confirm?task={{1}}) for BOTH the existing
 * worker task-confirmation flow (public.tasks.id) and the new
 * owner-escalation deep link (staff_escalation_owner_decisions.
 * deep_link_token), which share the same query param and are otherwise
 * indistinguishable by format alone (both are UUIDs).
 *
 * Discriminator: probes the existing, unmodified GET /api/task-confirm
 * endpoint first — read-only, no side effects, the exact same request
 * Confirm.tsx already issues for a real task link. A genuine 404 (the
 * value is not a real task id) resolves to "owner_escalation"; anything
 * else (a real task, or a non-404 error) resolves to "task", so
 * Confirm.tsx renders completely unmodified and performs its own fetch,
 * owning its own loading/error states exactly as before this change.
 * This means a real worker task link now does two GETs instead of one on
 * first paint — a deliberate, accepted tradeoff for never touching
 * Confirm.tsx's working, protected internals.
 *
 * Pure and directly testable with a mocked fetchImpl — no DOM/router
 * rendering required to prove the discrimination logic itself.
 */
export async function resolveConfirmLinkKind(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfirmLinkKind> {
  try {
    const res = await fetchImpl(`/api/task-confirm?taskId=${encodeURIComponent(token)}`);
    return res.status === 404 ? "owner_escalation" : "task";
  } catch {
    // Network failure on the probe: fall through to the existing worker
    // flow, which surfaces its own truthful error rather than silently
    // misrouting to the owner-escalation branch.
    return "task";
  }
}

export default function ConfirmRouter() {
  const [params] = useSearchParams();
  const token = params.get("task") ?? params.get("task_id");
  const [kind, setKind] = useState<ConfirmLinkKind | "loading">("loading");

  useEffect(() => {
    if (!token) {
      // No token at all — Confirm.tsx already has a truthful "Missing task
      // id in the link." error state for this case.
      setKind("task");
      return;
    }
    // Reset to "loading" synchronously before probing: if `token` changes
    // while this component stays mounted (no full remount), the previous
    // `kind` must not be rendered against the new token while the probe for
    // the new token is still in flight.
    setKind("loading");
    let cancelled = false;
    void resolveConfirmLinkKind(token).then((resolved) => {
      if (!cancelled) setKind(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (kind === "loading") {
    return (
      <div className="flex items-center justify-center py-16 text-ink/60">
        <Spinner size={22} label="Loading" />
      </div>
    );
  }

  if (kind === "owner_escalation" && token) {
    return <OwnerEscalationDecision token={token} />;
  }

  return <Confirm />;
}
