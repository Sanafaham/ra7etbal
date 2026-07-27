import { useEffect, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import type { AuthStatus } from "../stores/auth";
import { getOwnerEscalationByToken } from "../lib/staff-messages";
import { formatEscalationReceivedAt } from "../components/tasks/StaffEscalationCard";
import type { OwnerEscalationDetail } from "../types/staff-message";

/**
 * Phase C — the secure owner-decision page reached via a
 * staff_escalation_owner_decisions.deep_link_token (the WhatsApp "Visit
 * Task" button). Deliberately does NOT reuse api/task-confirm.js or
 * Confirm.tsx's worker proof-submission logic — this is a completely
 * separate table (staff_escalation_owner_decisions), a completely
 * different audience (the authenticated owner, not an anonymous worker),
 * and a completely different data shape.
 *
 * Security: requires the signed-in owner before attempting any query.
 * getOwnerEscalationByToken() relies entirely on RLS (auth.uid() =
 * user_id) — a token belonging to another household resolves to `null`,
 * identically to a token that doesn't exist at all, so this page can
 * never reveal whether a given token belongs to someone else.
 *
 * Read-only by design for this Phase C slice: no answer is persisted, no
 * RPC is called, no staff message is sent, and the escalation is never
 * resolved just by opening this page. Decision controls are explicitly
 * not yet available — that is Phase D's job.
 *
 * Split into a stateful wrapper (data fetching, below) and a pure,
 * hook-free View so the rendering logic — every load/auth state — can be
 * tested directly via renderToStaticMarkup, matching StaffUpdates.tsx's
 * existing convention.
 */

export type LoadState = "idle" | "loading" | "ready" | "not_found" | "error";

export interface OwnerEscalationDecisionViewProps {
  authStatus: AuthStatus;
  loadState: LoadState;
  loadError: string | null;
  detail: OwnerEscalationDetail | null;
  now: Date;
}

export function OwnerEscalationDecisionView({
  authStatus,
  loadState,
  loadError,
  detail,
  now,
}: OwnerEscalationDecisionViewProps) {
  if (authStatus === "loading") {
    return (
      <div className="mx-auto max-w-lg px-5 py-16">
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={22} label="Loading" />
        </div>
      </div>
    );
  }

  if (authStatus === "signed_out" || authStatus === "recovery") {
    return (
      <div className="mx-auto max-w-lg px-5 py-16">
        <AuthNotice kind="info">
          Sign in as the household owner to view this decision.{" "}
          <a href="/auth" className="underline">
            Sign in
          </a>
        </AuthNotice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-5 py-10">
      <h1 className="text-[22px] font-semibold text-ink">Owner decision</h1>

      {(loadState === "idle" || loadState === "loading") && (
        <div className="mt-6 flex items-center justify-center py-12 text-ink/60">
          <Spinner size={22} label="Loading" />
        </div>
      )}

      {loadState === "not_found" && (
        <div className="mt-6">
          <AuthNotice kind="error">
            This link is invalid, expired, or not associated with your account.
          </AuthNotice>
        </div>
      )}

      {loadState === "error" && (
        <div className="mt-6">
          <AuthNotice kind="error">{loadError}</AuthNotice>
        </div>
      )}

      {loadState === "ready" && detail && (
        <div className="mt-6 space-y-4">
          <AuthNotice kind={detail.alreadyAnswered ? "success" : "info"}>
            {detail.alreadyAnswered
              ? "You already responded to this request."
              : "Status: Needs You — awaiting your decision."}
          </AuthNotice>

          <article className="rounded-2xl border border-border bg-white/85 p-4 shadow-sm">
            <p className="text-sm font-medium text-ink">{detail.staffName}</p>
            <p className="mt-1 text-[11px] text-ink/40">
              {formatEscalationReceivedAt(detail.receivedAt, now)}
            </p>

            {detail.escalationReason && (
              <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                <p className="font-medium">Decision needed</p>
                <p className="mt-0.5">{detail.escalationReason}</p>
              </div>
            )}

            <p className="mt-3 whitespace-pre-wrap rounded-lg border border-border bg-cream/40 px-3 py-2 text-sm italic text-ink/75">
              "{detail.inboundText}"
            </p>
          </article>

          {!detail.alreadyAnswered && (
            <div className="rounded-2xl border border-dashed border-border bg-white/40 px-4 py-4 text-sm text-ink/60">
              Decision controls are coming next. This request will remain in Needs You until you respond through Carson.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface OwnerEscalationDecisionProps {
  token: string;
}

export default function OwnerEscalationDecision({ token }: OwnerEscalationDecisionProps) {
  const { status: authStatus } = useAuth();
  const [detail, setDetail] = useState<OwnerEscalationDetail | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // Never attempt the lookup until the owner is genuinely signed in —
    // an anonymous or still-resolving caller must not even try.
    if (authStatus !== "signed_in") return;
    let cancelled = false;
    setLoadState("loading");
    setLoadError(null);
    (async () => {
      try {
        const result = await getOwnerEscalationByToken(token);
        if (cancelled) return;
        if (!result) {
          setLoadState("not_found");
          return;
        }
        setDetail(result);
        setLoadState("ready");
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Could not load this decision. Please try again.");
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authStatus, token]);

  return (
    <OwnerEscalationDecisionView
      authStatus={authStatus}
      loadState={loadState}
      loadError={loadError}
      detail={detail}
      now={new Date()}
    />
  );
}
