/**
 * whatsapp-delivery-context.ts
 *
 * Fetches recent WhatsApp delivery failures from Supabase and formats them
 * for Carson — same pattern as automation-context.ts.
 *
 * Phase 9A Visibility Layer, Step 1: this data (whatsapp_deliveries.failure_*)
 * was already being captured by the webhook but never read back anywhere —
 * not by the UI, not by Carson. This module closes that gap by reusing the
 * existing columns; no schema change, no new integration.
 */

import { supabase } from "./supabase";

export interface WhatsappDeliveryFailureSummary {
  recipientName: string | null;
  /** "message" | "automation_message" | "task" | etc — whatsapp_deliveries.source_type */
  sourceType: string | null;
  failureReason: string | null;
  failureCode: string | null;
  /** ms elapsed since failed_at (falls back to last_status_at if failed_at is missing) */
  failedAgoMs: number;
}

const MAX_TEXT = 5;

/**
 * Fetches WhatsApp deliveries marked `failed` in the last 48 h.
 * Returns [] on auth failure or query error (never throws) — same
 * fail-safe contract as fetchAutomationDigest().
 */
export async function fetchWhatsappDeliveryFailures(): Promise<WhatsappDeliveryFailureSummary[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const window48hAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();

  const { data } = await supabase
    .from("whatsapp_deliveries")
    .select("recipient_name, source_type, failure_reason, failure_code, failed_at, last_status_at")
    .eq("delivery_status", "failed")
    .gte("failed_at", window48hAgo)
    .order("failed_at", { ascending: false })
    .limit(10);

  const nowMs = Date.now();

  return ((data ?? []) as Record<string, unknown>[]).map((row) => {
    const failedAt = (row.failed_at as string | null) ?? (row.last_status_at as string | null);
    return {
      recipientName: (row.recipient_name as string | null) ?? null,
      sourceType: (row.source_type as string | null) ?? null,
      failureReason: (row.failure_reason as string | null) ?? null,
      failureCode: (row.failure_code as string | null) ?? null,
      failedAgoMs: failedAt ? nowMs - new Date(failedAt).getTime() : 0,
    };
  });
}

function msToAgo(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.round(ms / 60_000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Builds the WHATSAPP DELIVERY ISSUES text block for ra7etbal_state / Carson
 * context. Pure function — takes a pre-fetched failure list.
 */
export function buildWhatsappDeliveryStatusBlock(failures: WhatsappDeliveryFailureSummary[]): string {
  if (failures.length === 0) return "";

  // Background reference only — Carson must not volunteer this unprompted
  // or use it to editorialize (e.g. "given the recent delivery issues, I'd
  // recommend calling directly") on an unrelated, currently-successful
  // send. A confirmed production incident: this stale historical block sat
  // in context for a whole session and got attached to an unrelated send
  // confirmation. Only surface it if the user actually asks about delivery
  // or message status for that person.
  const lines: string[] = [
    "WHATSAPP DELIVERY ISSUES (last 48h) — background only. Do not mention unless the user asks about delivery or message status for that person. Never use this to recommend contacting someone directly or to editorialize on reliability.",
  ];
  for (const f of failures.slice(0, MAX_TEXT)) {
    const who = f.recipientName ? ` to ${f.recipientName}` : "";
    const age = msToAgo(f.failedAgoMs);
    const reason = f.failureReason ? `: ${f.failureReason}` : "";
    lines.push(`- Failed${who} — ${age}${reason}`);
  }
  if (failures.length > MAX_TEXT) {
    lines.push(`(showing ${MAX_TEXT} of ${failures.length} failures)`);
  }
  return lines.join("\n");
}

/**
 * Fetches failures and returns the formatted block in one call.
 * Used for the initial page-load context string, mirroring
 * fetchAndBuildAutomationStatusBlock().
 */
export async function fetchAndBuildWhatsappDeliveryStatusBlock(): Promise<string> {
  const failures = await fetchWhatsappDeliveryFailures().catch(() => []);
  return buildWhatsappDeliveryStatusBlock(failures);
}
