/**
 * Server-side (Supabase-persisted) Carson tool-invocation diagnostics.
 *
 * Confirmed production incidents (2026-07-29): a direct-message request
 * repeatedly produced zero messages/whatsapp_deliveries rows and zero
 * transport logs, with no way to distinguish "the model never called the
 * tool" from "the client never received the call" from "the policy gate
 * rejected it" from "the handler ran and exited early" from "the backend
 * call failed" — every investigation on this incident hit the same wall:
 * no persisted record of what actually happened during the turn.
 *
 * This is a *separate* mechanism from carson-diagnostics.ts's
 * `recordCarsonDiagnostic`, which is a client-only (localStorage) ring
 * buffer for developer troubleshooting. This module persists to Supabase
 * (owner-scoped RLS, see supabase/migrations/20260731_carson_tool_diagnostics.sql)
 * so a future incident is diagnosable from the database without needing a
 * live screenshot. No raw message or instruction content is ever stored —
 * only stage, a short deterministic reason, safe identifiers, and hashes.
 *
 * Every call here must be fire-and-forget and never throw — diagnostic
 * logging must never block or alter the user-facing reply, matching the
 * existing convention throughout this codebase.
 */
import { supabase } from "./supabase";

export type CarsonToolDiagnosticStage =
  | "invoked"
  | "policy_rejected"
  | "typed_blocked"
  | "handler_started"
  | "handler_success"
  | "handler_failure"
  | "claim_overridden"
  // Carson intent-architecture (2026-07-30): route_people_action is the new
  // semantic entry point for communication/delegation — these three stages
  // trace its routing decisions without ever recording raw utterance text.
  // people_action_mapped: the envelope was coherent and entities were
  // present; records which existing tool (send_direct_whatsapp_message or
  // send_delegation) the deterministic mapping selected.
  | "people_action_mapped"
  // people_action_clarify: the envelope was missing information, the model
  // flagged its own ambiguity, or actionType disagreed with the evidence
  // booleans — Carson asked one clarifying question instead of guessing.
  | "people_action_clarify"
  // legacy_people_tool_bypass: the model called send_direct_whatsapp_message
  // or send_delegation directly, bypassing route_people_action. Recorded as
  // compatibility telemetry during rollout, not treated as the desired
  // steady state — see RA7ETBAL_STATE.md.
  | "legacy_people_tool_bypass";

export interface RecordCarsonToolDiagnosticInput {
  userId: string | null | undefined;
  sessionId: string | null | undefined;
  channel: "voice" | "text";
  toolName: string;
  stage: CarsonToolDiagnosticStage;
  reason?: string | null;
  missingEntities?: readonly string[];
  recipientPersonId?: string | null;
  utterance?: string | null;
  message?: string | null;
  /** route_people_action only — the model's own actionType, never raw text. */
  actionType?: string | null;
  /** route_people_action only — the app-selected internal execution tool. */
  selectedTool?: string | null;
}

async function sha256Hex(text: string): Promise<string | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** Fire-and-forget. Never throws, never blocks the caller. */
export function recordCarsonToolDiagnostic(input: RecordCarsonToolDiagnosticInput): void {
  void (async () => {
    try {
      if (!input.userId || !input.sessionId) return;
      const [utteranceHash, messageHash] = await Promise.all([
        input.utterance ? sha256Hex(input.utterance) : Promise.resolve(null),
        input.message ? sha256Hex(input.message) : Promise.resolve(null),
      ]);
      const { error } = await supabase.from("carson_tool_diagnostics").insert({
        user_id: input.userId,
        session_id: input.sessionId,
        channel: input.channel,
        tool_name: input.toolName,
        stage: input.stage,
        reason: input.reason ?? null,
        missing_entities: input.missingEntities ?? [],
        recipient_person_id: input.recipientPersonId ?? null,
        utterance_hash: utteranceHash,
        message_hash: messageHash,
        action_type: input.actionType ?? null,
        selected_tool: input.selectedTool ?? null,
      });
      if (error) {
        console.warn("[carson-tool-diagnostics] insert failed", error.message);
      }
    } catch (err) {
      console.warn("[carson-tool-diagnostics] insert threw", err);
    }
  })();
}
