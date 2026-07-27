/**
 * Client helper for the Phase D owner-escalation-answer endpoint
 * (PATCH /api/task-confirm, discriminated by deepLinkToken — see
 * api/task-confirm.js's handleEscalationAnswer). Mirrors
 * quality-substitute-decision.ts's shape exactly: a direct user action with
 * success/error states the UI must surface, not fire-and-forget.
 */

import { supabase } from "./supabase";

export type EscalationDecision = "approved" | "rejected" | "custom_instruction";

/**
 * status mirrors what the server actually confirmed, never an optimistic
 * guess: "delivered" only when Meta accepted the send;
 * "sent_unconfirmed" when Meta accepted but our own bookkeeping failed
 * afterward (still truthful — the message did go out); "in_progress" when
 * a delivery attempt is already underway (this or a concurrent request);
 * "saved_unreachable" when the answer was stored but staff can't
 * currently be reached on WhatsApp.
 */
export type EscalationAnswerStatus = "delivered" | "sent_unconfirmed" | "in_progress" | "saved_unreachable";

export interface EscalationAnswerResult {
  success: boolean;
  status?: EscalationAnswerStatus;
  ownerReplyText?: string;
  error?: string;
}

export async function submitEscalationDecision({
  deepLinkToken,
  decision,
  instructionText,
}: {
  deepLinkToken: string;
  /**
   * Omit only to retry delivery on an already-answered (typically
   * 'failed') escalation — the server ignores decision/instructionText
   * whenever the escalation isn't still 'open', reusing the answer
   * already stored instead.
   */
  decision?: EscalationDecision;
  instructionText?: string | null;
}): Promise<EscalationAnswerResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) {
    return { success: false, error: "You need to be signed in to do this. Please reload and try again." };
  }

  try {
    const res = await fetch("/api/task-confirm", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        deepLinkToken,
        decision,
        ...(instructionText ? { instructionText } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      status?: EscalationAnswerStatus;
      ownerReplyText?: string;
      error?: string;
    };
    if (!res.ok || data?.error) {
      return { success: false, error: data?.error || `Could not process this decision (HTTP ${res.status}).` };
    }
    return { success: true, status: data?.status, ownerReplyText: data?.ownerReplyText };
  } catch {
    return { success: false, error: "Network issue. Please check your connection and try again." };
  }
}
