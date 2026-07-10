/**
 * Client helper for the Phase 8.1 owner decision endpoint
 * (PATCH /api/task-confirm — see api/task-confirm.js's handleOwnerDecision).
 *
 * Not fire-and-forget like qstash-reminder.ts: this is a direct user action
 * with success/error states the UI must surface (Approve/Reject/Custom
 * Instruction buttons on the Needs You substitute_review card).
 */

import { supabase } from "./supabase";

export type SubstituteDecision = "approved_alternative" | "rejected_alternative" | "custom_instruction";

export interface SubstituteDecisionResult {
  success: boolean;
  outcome?: string;
  error?: string;
}

export async function submitSubstituteDecision({
  taskId,
  decision,
  instructionText,
  reviewedAt,
}: {
  taskId: string;
  decision: SubstituteDecision;
  instructionText?: string | null;
  reviewedAt?: string | null;
}): Promise<SubstituteDecisionResult> {
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
        taskId,
        decision,
        ...(instructionText ? { instructionText } : {}),
        ...(reviewedAt ? { reviewedAt } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
    if (!res.ok || data?.error) {
      return { success: false, error: data?.error || `Could not process this decision (HTTP ${res.status}).` };
    }
    return { success: true, outcome: data?.outcome };
  } catch {
    return { success: false, error: "Network issue. Please check your connection and try again." };
  }
}
