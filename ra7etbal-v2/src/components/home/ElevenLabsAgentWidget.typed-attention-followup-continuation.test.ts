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
 * 2026-08-28 — updated for the Second Brain stateful reasoning correction:
 * admission for a continuation is no longer gated on matchesAttentionFollowUp
 * at all (see ElevenLabsAgentWidget.typed-attention-reasoning.test.ts for
 * the reasoning-path tests themselves). This file keeps covering the
 * conversation-state plumbing: what gets sent, when, and its trust level.
 */
describe("ElevenLabsAgentWidget — typed attention conversation-state continuity", () => {
  it("sends conversation-state continuation context only when there is active grounded attention context — never for a bare direct match alone", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    const continuationIndex = attentionBlock.indexOf("const conversationStateContext =");
    expect(continuationIndex).toBeGreaterThan(-1);
    const snippet = attentionBlock.slice(continuationIndex, continuationIndex + 500);
    expect(snippet).toContain("hasActiveGroundedAttentionContext");
    expect(snippet).toContain(": {}");
  });

  it("the continuation context sent to the server carries only the four approved minimal fields — no operational facts, no identity", () => {
    const attentionBlock = blockBetween(
      "const conversationStateContext =",
      "const response = await fetch",
    );
    expect(attentionBlock).toContain('previousCapability: "attention_summary_read"');
    expect(attentionBlock).toContain('previousGroundingStatus: "grounded"');
    expect(attentionBlock).toContain("previouslySurfacedEvidenceIds: previouslySurfacedEvidenceIdsRef.current");
    expect(attentionBlock).toContain("priorObjective: priorAttentionObjectiveRef.current");
    expect(attentionBlock).not.toMatch(/accountId|userId|user_id|task_id|email|phone/i);
  });

  it("resets lastAttentionTurnWasGroundedRef and the conversation-state refs at the same session lifecycle points (3 pre-existing reset sites, plus the not_attention reset); the conversation-state refs additionally reset once more whenever a claimed result's capability isn't attention_summary_read (2026-08-28 CodeRabbit finding — stale surfaced-evidence context must not persist across an intervening non-attention turn)", () => {
    const groundedResets = SOURCE.split("lastAttentionTurnWasGroundedRef.current = false;").length - 1;
    const surfacedResets = SOURCE.split("previouslySurfacedEvidenceIdsRef.current = [];").length - 1;
    const objectiveResets = SOURCE.split("priorAttentionObjectiveRef.current = null;").length - 1;
    expect(groundedResets).toBe(4);
    expect(surfacedResets).toBe(5);
    expect(objectiveResets).toBe(5);
  });

  it("does not alter any voice-only (requestedChannel === \"voice\") code path", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).not.toContain('requestedChannel === "voice"');
    expect(attentionBlock).not.toContain("setMicMuted");
    expect(attentionBlock).not.toContain("connectionDelay");
  });
});
