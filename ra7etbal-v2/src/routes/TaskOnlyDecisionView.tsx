import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import type { NoResponseChoice, NoResponseResultStatus } from "../lib/escalation-answer";
import type { TaskOnlyEscalationDetail } from "../types/staff-message";

/**
 * Slice 1 — owner decision page for a TASK-ONLY decision (no staff message).
 *
 * For review_type 'no_response' the owner gets exactly two choices:
 *   Ask again    — Carson sends the assignee one message about this task.
 *   Keep waiting — nothing is sent; the task stays open.
 * There is no Approve / Reject / Custom instruction here: nothing was
 * proposed and the assignee did not write anything to approve.
 *
 * Every other task-only review type is shown read-only: this link cannot
 * answer it. The page never invents an inbound message or a staff reply, and
 * it is actionable only while the task is still current. The server re-checks
 * the live task, replies and proof before recording or sending anything.
 *
 * Pure and hook-free so every state is testable via renderToStaticMarkup.
 */

export type TaskOnlySubmitPhase = "idle" | "confirming_ask_again" | "sending";

export interface TaskOnlyDecisionViewProps {
  detail: TaskOnlyEscalationDetail;
  submitPhase: TaskOnlySubmitPhase;
  submitError: string | null;
  /** Server-confirmed outcome of this session's submission, if any. */
  result: NoResponseResultStatus | null;
  onChoose: (choice: NoResponseChoice) => void;
  onConfirmAskAgain: () => void;
  onCancel: () => void;
  onRetryDelivery: () => void;
}

function who(detail: TaskOnlyEscalationDetail): string {
  return detail.assigneeName?.trim() || "the assignee";
}

export function notCurrentText(reason: TaskOnlyEscalationDetail["taskNotCurrentReason"]): string | null {
  switch (reason) {
    case null:
      return null;
    case "completed":
    case "confirmed":
      return "This task is already done, so there's nothing to decide.";
    case "archived":
    case "dismissed":
      return "This task was closed, so there's nothing to decide.";
    case "not_pending":
      return "This task is no longer open, so there's nothing to decide.";
    case "task_unavailable":
      return "This task is no longer available, so there's nothing to decide.";
  }
}

export function resultText(result: NoResponseResultStatus, name: string): string {
  switch (result) {
    case "kept_waiting":
      return `Okay — Carson will keep waiting. Nothing was sent to ${name}, and the task stays open.`;
    case "delivered":
      return `Carson asked ${name} again. The task stays open until it's confirmed done.`;
    case "sent_unconfirmed":
      return `The message to ${name} was sent, but we couldn't confirm it in our records. The task stays open.`;
    case "in_progress":
      return `Your choice is saved. The message to ${name} is already being sent.`;
    case "saved_unreachable":
      return `Your choice is saved, but Carson couldn't reach ${name} on WhatsApp, so nothing was sent.`;
    case "not_sent_no_longer_current":
      return `Nothing was sent — this task no longer needs a nudge (it was finished, ${name} replied, or newer proof arrived).`;
    case "sent_then_superseded":
      return `Carson's message to ${name} was sent, and newer proof for this task arrived right after. That proof is now the current review.`;
  }
}

/** Truthful summary of an already-answered decision on first load. */
export function answeredText(detail: TaskOnlyEscalationDetail): string {
  const name = who(detail);
  if (detail.status === "superseded") {
    // Newer same-task evidence (proof submitted through this task's own link)
    // replaced this silence handoff. Never claims a send was prevented or
    // happened; the owner's earlier choice, if any, stays in history.
    const earlier =
      detail.ownerChoice === "ask_again"
        ? " Your earlier choice (Ask again) is kept in history."
        : detail.ownerChoice === "keep_waiting"
          ? " Your earlier choice (Keep waiting) is kept in history."
          : "";
    return `Newer information arrived for this task, so this question about ${name} no longer applies and there is nothing to decide here.${earlier}`;
  }
  if (detail.ownerChoice === "keep_waiting") {
    return `You chose to keep waiting. Nothing was sent to ${name}.`;
  }
  if (detail.ownerChoice === "ask_again") {
    if (detail.status === "delivered_to_staff") return `You chose to ask again. Carson sent ${name} one message.`;
    if (detail.status === "failed") return `You chose to ask again, but the message to ${name} didn't go out.`;
    if (detail.status === "delivering") return `You chose to ask again. The message to ${name} is being sent.`;
    return `You chose to ask again. The message to ${name} hasn't been confirmed as sent.`;
  }
  return "You already answered this.";
}

export function TaskOnlyDecisionView({
  detail,
  submitPhase,
  submitError,
  result,
  onChoose,
  onConfirmAskAgain,
  onCancel,
  onRetryDelivery,
}: TaskOnlyDecisionViewProps) {
  const name = who(detail);
  const isNoResponse = detail.reviewType === "no_response";
  const notCurrent = notCurrentText(detail.taskNotCurrentReason);
  const canChoose = isNoResponse && detail.status === "open" && !notCurrent && !result;
  const canRetry =
    isNoResponse && detail.status === "failed" && detail.ownerChoice === "ask_again" && !notCurrent && !result;

  return (
    <div className="mx-auto max-w-lg px-5 py-10">
      <h1 className="text-[22px] font-semibold text-ink">Owner decision</h1>
      <div className="mt-6 space-y-4">
        <article className="rounded-2xl border border-border bg-white/85 p-4 shadow-sm">
          <p className="text-sm font-medium text-ink">{detail.assigneeName ?? "Unassigned"}</p>
          <p className="mt-2 text-sm text-ink">{detail.taskDescription ?? "Task details are unavailable."}</p>
        </article>

        {result ? (
          <AuthNotice kind={result === "saved_unreachable" ? "error" : "success"}>{resultText(result, name)}</AuthNotice>
        ) : !isNoResponse ? (
          <AuthNotice kind="info">This decision can't be answered from this link.</AuthNotice>
        ) : detail.status !== "open" ? (
          <AuthNotice kind={detail.status === "failed" ? "error" : "info"}>{answeredText(detail)}</AuthNotice>
        ) : notCurrent ? (
          <AuthNotice kind="info">{notCurrent}</AuthNotice>
        ) : (
          <AuthNotice kind="info">
            {`Carson asked you because ${name} hadn't replied after the follow-up. What should Carson do?`}
          </AuthNotice>
        )}

        {!result && detail.status !== "open" && notCurrent && isNoResponse && (
          <AuthNotice kind="info">{notCurrent}</AuthNotice>
        )}

        {submitError && <AuthNotice kind="error">{submitError}</AuthNotice>}

        {canChoose && (
          <div className="rounded-2xl border border-border bg-white/60 p-4 space-y-3">
            {submitPhase === "idle" && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onChoose("ask_again")}
                  className="rounded-full bg-sage px-4 py-2 text-sm font-medium text-white"
                >
                  Ask again
                </button>
                <button
                  type="button"
                  onClick={() => onChoose("keep_waiting")}
                  className="rounded-full border border-border px-4 py-2 text-sm font-medium text-ink"
                >
                  Keep waiting
                </button>
              </div>
            )}
            {submitPhase === "confirming_ask_again" && (
              <div className="space-y-2">
                <p className="text-sm text-ink">
                  {`Carson will send ${name} one message asking again about this task. Send it?`}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onConfirmAskAgain}
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
              <div className="flex items-center gap-2 text-sm text-ink">
                <Spinner size={16} label="Saving" />
                Saving your choice…
              </div>
            )}
          </div>
        )}

        {canRetry && (
          <div className="rounded-2xl border border-dashed border-border bg-white/40 p-4 space-y-2">
            {submitPhase === "sending" ? (
              <div className="flex items-center gap-2 text-sm text-ink">
                <Spinner size={16} label="Sending" />
                Sending to {name}…
              </div>
            ) : (
              <button
                type="button"
                onClick={onRetryDelivery}
                className="rounded-full bg-sage px-4 py-2 text-sm font-medium text-white"
              >
                Try sending again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
