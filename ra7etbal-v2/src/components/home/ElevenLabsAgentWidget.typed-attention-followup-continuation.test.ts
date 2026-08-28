import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/**
 * 2026-08-28 — narrow fix for a real production regression found by the
 * post-merge canary: the widget correctly recognized "What else?" as a
 * continuation of a grounded attention turn, but the stateless server
 * coordinator had no way to know that and rejected it as unsupported_intent,
 * falling back to the honest-but-wrong "couldn't check" message instead of
 * a fresh grounded answer.
 *
 * Fix: the widget sends minimal, non-security continuation context
 * (previousCapability/previousGroundingStatus) only when the immediately
 * preceding turn actually grounded — never for a failed predecessor, never
 * operational facts, never identity. See api/_carson-read-turn.test.js for
 * the server-side independent-verification proof.
 */
describe("ElevenLabsAgentWidget — typed attention follow-up continuation context", () => {
  it("only builds continuation context for an actual follow-up whose predecessor actually grounded", () => {
    const attentionBlock = blockBetween(
      "const isTypedAttentionFollowUp =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain(
      "isTypedAttentionFollowUp && lastAttentionTurnWasGroundedRef.current",
    );
    expect(attentionBlock).toContain('previousCapability: "attention_summary_read"');
    expect(attentionBlock).toContain('previousGroundingStatus: "grounded"');
  });

  it("never sends continuation context for a direct (non-follow-up) attention request", () => {
    const attentionBlock = blockBetween(
      "const isTypedAttentionFollowUp =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    // The continuation object is only non-empty when isTypedAttentionFollowUp
    // is true — a direct match alone (matchesAttentionIntent) never sets it.
    const continuationIndex = attentionBlock.indexOf("const continuationContext =");
    expect(continuationIndex).toBeGreaterThan(-1);
    const ternaryStart = attentionBlock.slice(continuationIndex, continuationIndex + 400);
    expect(ternaryStart).toContain("isTypedAttentionFollowUp && lastAttentionTurnWasGroundedRef.current");
    expect(ternaryStart).toContain(": {}");
  });

  it("tracks whether THIS turn actually grounded, from the server's real groundingStatus — not assumed", () => {
    const attentionBlock = blockBetween(
      "const isTypedAttentionFollowUp =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain("result?.groundingStatus");
    expect(attentionBlock).toContain(
      'lastAttentionTurnWasGroundedRef.current = typedGroundingStatus === "grounded";',
    );
  });

  it("resets lastAttentionTurnWasGroundedRef at the same 3 session reset sites as before (no new/removed reset site)", () => {
    const resets = SOURCE.split("lastAttentionTurnWasGroundedRef.current = false;").length - 1;
    expect(resets).toBe(3);
  });

  it("the continuation context is built entirely from client-local refs — no operational facts, no identity fields", () => {
    const attentionBlock = blockBetween(
      "const continuationContext =",
      "const response = await fetch",
    );
    // Only the two documented classification fields may appear in the object.
    expect(attentionBlock).not.toMatch(/accountId|userId|user_id|task_id|email|phone/i);
  });

  it("does not alter any voice-only (requestedChannel === \"voice\") code path", () => {
    const attentionBlock = blockBetween(
      "const isTypedAttentionFollowUp =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).not.toContain('requestedChannel === "voice"');
    expect(attentionBlock).not.toContain("setMicMuted");
  });
});
