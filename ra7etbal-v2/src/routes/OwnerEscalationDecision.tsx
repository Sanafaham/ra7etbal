import { useEffect, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import type { AuthStatus } from "../stores/auth";
import { getOwnerEscalationByToken } from "../lib/staff-messages";
import { submitEscalationDecision, type EscalationDecision } from "../lib/escalation-answer";
import { formatEscalationReceivedAt } from "../components/tasks/StaffEscalationCard";
import type { OwnerEscalationDetail } from "../types/staff-message";

/**
 * Phase C/D — the secure owner-decision page reached via a
 * staff_escalation_owner_decisions.deep_link_token (the WhatsApp "Visit
 * Task" button). Deliberately does NOT reuse api/task-confirm.js's
 * taskId-based Alternative Review branch or Confirm.tsx's worker
 * proof-submission logic — this is a completely separate table
 * (staff_escalation_owner_decisions), a completely different audience
 * (the authenticated owner, not an anonymous worker), and a completely
 * different data shape. The PATCH request below hits the same
 * api/task-confirm.js file, but a separate branch discriminated by
 * `deepLinkToken` in the body — see handleEscalationAnswer there.
 *
 * Security: requires the signed-in owner before attempting any query.
 * getOwnerEscalationByToken() relies entirely on RLS (auth.uid() =
 * user_id) — a token belonging to another household resolves to `null`,
 * identically to a token that doesn't exist at all, so this page can
 * never reveal whether a given token belongs to someone else. The write
 * path (submitEscalationDecision) is separately, explicitly
 * ownership-checked server-side — see that function's own doc comment.
 *
 * Phase D: the owner answers here (Approve / Reject / Custom
 * instruction), and Ra7etBal — never the owner manually — delivers that
 * answer to staff. This page never shows "Sent" unless the server
 * confirmed Meta accepted the message; a failed delivery stays visible
 * with a retry action, never silently disappears.
 *
 * Split into a stateful wrapper (data fetching + submission, below) and a
 * pure, hook-free View so every load/auth/submission state can be tested
 * directly via renderToStaticMarkup, matching StaffUpdates.tsx's existing
 * convention.
 */

export type LoadState = "idle" | "loading" | "ready" | "not_found" | "error";

/**
 * idle: nothing selected yet — three buttons shown (open escalations only).
 * custom_editing: the owner is typing a custom instruction.
 * confirming: the exact text to be sent is shown, awaiting Send/Cancel —
 *   the required lightweight confirmation step before anything is sent.
 * sending: the PATCH request is in flight.
 */
export type SubmitPhase = "idle" | "custom_editing" | "confirming" | "sending";

export interface OwnerEscalationDecisionViewProps {
  authStatus: AuthStatus;
  loadState: LoadState;
  loadError: string | null;
  detail: OwnerEscalationDetail | null;
  now: Date;
  submitPhase: SubmitPhase;
  pendingDecision: EscalationDecision | null;
  customText: string;
  submitError: string | null;
  /** True only immediately after a "Meta accepted, but our own bookkeeping failed" response — see handleEscalationAnswer's 'sent_unconfirmed' case. Cleared on the next reload/interaction. */
  deliverySentUnconfirmed: boolean;
  onSelectDecision: (decision: EscalationDecision) => void;
  onCustomTextChange: (value: string) => void;
  onContinueCustom: () => void;
  onCancel: () => void;
  onConfirmSend: () => void;
  onRetryDelivery: () => void;
}

function statusNoticeKind(status: OwnerEscalationDetail["status"]): "info" | "success" | "error" {
  if (status === "delivered_to_staff") return "success";
  if (status === "failed") return "error";
  return "info";
}

function statusNoticeText(status: OwnerEscalationDetail["status"], staffName: string): string {
  switch (status) {
    case "open":
      return "Status: Needs You — awaiting your decision.";
    case "answered":
    case "delivering":
      return `Your answer is saved. Sending to ${staffName}…`;
    case "failed":
      return `Your answer was saved, but ${staffName} hasn't been notified yet.`;
    case "delivered_to_staff":
      return "You already responded to this request.";
  }
}

const DECISION_PREVIEW_TEXT: Record<Exclude<EscalationDecision, "custom_instruction">, string> = {
  approved: "Yes, buy the red wine vinegar instead.",
  rejected: "No, do not buy it. Continue without it.",
};

export function OwnerEscalationDecisionView({
  authStatus,
  loadState,
  loadError,
  detail,
  now,
  submitPhase,
  pendingDecision,
  customText,
  submitError,
  deliverySentUnconfirmed,
  onSelectDecision,
  onCustomTextChange,
  onContinueCustom,
  onCancel,
  onConfirmSend,
  onRetryDelivery,
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
          <AuthNotice kind={deliverySentUnconfirmed ? "success" : statusNoticeKind(detail.status)}>
            {deliverySentUnconfirmed
              ? `Your answer was sent to ${detail.staffName}, but we couldn't confirm it in our records — no action needed from you.`
              : statusNoticeText(detail.status, detail.staffName)}
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

          {submitError && (
            <AuthNotice kind="error">{submitError}</AuthNotice>
          )}

          {detail.status === "open" && !deliverySentUnconfirmed && (
            <div className="rounded-2xl border border-border bg-white/60 p-4 space-y-3">
              {submitPhase === "idle" && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectDecision("approved")}
                    className="rounded-full bg-sage px-4 py-2 text-sm font-medium text-white"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectDecision("rejected")}
                    className="rounded-full bg-rose-500 px-4 py-2 text-sm font-medium text-white"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectDecision("custom_instruction")}
                    className="rounded-full border border-border px-4 py-2 text-sm font-medium text-ink"
                  >
                    Custom instruction
                  </button>
                </div>
              )}

              {submitPhase === "custom_editing" && (
                <div className="space-y-2">
                  <textarea
                    value={customText}
                    onChange={(e) => onCustomTextChange(e.target.value)}
                    maxLength={1000}
                    placeholder="Tell Christopher what to do…"
                    className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
                    rows={3}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={onContinueCustom}
                      disabled={!customText.trim()}
                      className="rounded-full bg-sage px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Continue
                    </button>
                    <button
                      type="button"
                      onClick={onCancel}
                      className="rounded-full border border-border px-4 py-2 text-sm font-medium text-ink"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {submitPhase === "confirming" && pendingDecision && (
                <div className="space-y-2">
                  <p className="text-sm text-ink/70">Send this to {detail.staffName}?</p>
                  <p className="rounded-lg border border-border bg-cream/40 px-3 py-2 text-sm italic text-ink/85">
                    "
                    {pendingDecision === "custom_instruction"
                      ? customText.trim()
                      : DECISION_PREVIEW_TEXT[pendingDecision]}
                    "
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={onConfirmSend}
                      className="rounded-full bg-sage px-4 py-2 text-sm font-medium text-white"
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      onClick={onCancel}
                      className="rounded-full border border-border px-4 py-2 text-sm font-medium text-ink"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {submitPhase === "sending" && (
                <div className="flex items-center gap-2 text-sm text-ink/60">
                  <Spinner size={16} label="Sending" />
                  Sending to {detail.staffName}…
                </div>
              )}
            </div>
          )}

          {detail.status === "failed" && submitPhase === "idle" && (
            <div className="rounded-2xl border border-dashed border-border bg-white/40 p-4 space-y-2">
              <p className="text-sm text-ink/70">
                We couldn't reach {detail.staffName} with your answer. You can safely try again.
              </p>
              <button
                type="button"
                onClick={onRetryDelivery}
                className="rounded-full bg-sage px-4 py-2 text-sm font-medium text-white"
              >
                Retry
              </button>
            </div>
          )}

          {detail.status === "failed" && submitPhase === "sending" && (
            <div className="flex items-center gap-2 text-sm text-ink/60">
              <Spinner size={16} label="Sending" />
              Sending to {detail.staffName}…
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

  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>("idle");
  const [pendingDecision, setPendingDecision] = useState<EscalationDecision | null>(null);
  const [customText, setCustomText] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deliverySentUnconfirmed, setDeliverySentUnconfirmed] = useState(false);

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

  function resetSubmissionUi() {
    setSubmitPhase("idle");
    setPendingDecision(null);
    setCustomText("");
    setSubmitError(null);
  }

  function handleSelectDecision(decision: EscalationDecision) {
    setSubmitError(null);
    setPendingDecision(decision);
    setSubmitPhase(decision === "custom_instruction" ? "custom_editing" : "confirming");
  }

  function handleContinueCustom() {
    if (!customText.trim()) return;
    setSubmitPhase("confirming");
  }

  function handleCancel() {
    if (pendingDecision === "custom_instruction") {
      setSubmitPhase("custom_editing");
    } else {
      setSubmitPhase("idle");
      setPendingDecision(null);
    }
  }

  async function handleConfirmSend() {
    if (!pendingDecision) return;
    setSubmitPhase("sending");
    setSubmitError(null);
    const result = await submitEscalationDecision({
      deepLinkToken: token,
      decision: pendingDecision,
      instructionText: pendingDecision === "custom_instruction" ? customText : null,
    });
    applySubmitResult(result);
  }

  async function handleRetryDelivery() {
    setSubmitPhase("sending");
    setSubmitError(null);
    const result = await submitEscalationDecision({ deepLinkToken: token });
    applySubmitResult(result);
  }

  function applySubmitResult(result: Awaited<ReturnType<typeof submitEscalationDecision>>) {
    if (!result.success) {
      setSubmitPhase(pendingDecision ? "confirming" : "idle");
      setSubmitError(result.error || "Could not process this decision. Please try again.");
      return;
    }
    resetSubmissionUi();
    setDeliverySentUnconfirmed(result.status === "sent_unconfirmed");
    setDetail((current) => {
      if (!current) return current;
      if (result.status === "delivered") return { ...current, status: "delivered_to_staff", alreadyAnswered: true };
      if (result.status === "in_progress") return { ...current, status: "delivering", alreadyAnswered: true };
      if (result.status === "saved_unreachable") return { ...current, status: "failed", alreadyAnswered: true };
      // 'sent_unconfirmed': Meta accepted but our own completion write
      // failed — the DB row itself did not reach delivered_to_staff, so
      // status is deliberately left as whatever it already was rather
      // than guessed. The banner above (deliverySentUnconfirmed) carries
      // the truthful message for this one case.
      return current;
    });
  }

  return (
    <OwnerEscalationDecisionView
      authStatus={authStatus}
      loadState={loadState}
      loadError={loadError}
      detail={detail}
      now={new Date()}
      submitPhase={submitPhase}
      pendingDecision={pendingDecision}
      customText={customText}
      submitError={submitError}
      deliverySentUnconfirmed={deliverySentUnconfirmed}
      onSelectDecision={handleSelectDecision}
      onCustomTextChange={setCustomText}
      onContinueCustom={handleContinueCustom}
      onCancel={handleCancel}
      onConfirmSend={handleConfirmSend}
      onRetryDelivery={handleRetryDelivery}
    />
  );
}
