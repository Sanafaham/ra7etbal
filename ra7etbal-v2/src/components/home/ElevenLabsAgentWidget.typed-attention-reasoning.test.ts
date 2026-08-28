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
 * 2026-08-28 — Second Brain stateful reasoning slice (typed channel only).
 * Covers the architectural correction: admission for a continuation turn
 * is no longer gated on a growing regex of follow-up phrasings.
 */
describe("ElevenLabsAgentWidget — Second Brain stateful reasoning admission", () => {
  it("[revised admission] a message is a candidate when EITHER it directly matches attention intent OR active grounded attention context exists — no follow-up regex required for the second case", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain(
      "const typedAttentionCandidate = isDirectTypedAttentionIntent || hasActiveGroundedAttentionContext;",
    );
    // The old regex-gated admission must not remain.
    expect(SOURCE).not.toContain(
      "matchesAttentionFollowUp(savedMessage.content) && lastTurnWasAttentionIntentRef.current",
    );
  });

  it("[not_attention] a resolved not_attention decision does not persist a local reply and does not return — the turn falls through to the rest of sendTypedMessage unchanged", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain('result?.code === "not_attention"');
    expect(attentionBlock).toContain("notAttention = true;");
    const notAttentionBranchIndex = attentionBlock.indexOf("if (notAttention) {");
    const elseBranchIndex = attentionBlock.indexOf("} else {", notAttentionBranchIndex);
    expect(notAttentionBranchIndex).toBeGreaterThan(-1);
    expect(elseBranchIndex).toBeGreaterThan(notAttentionBranchIndex);
    const notAttentionBranch = attentionBlock.slice(notAttentionBranchIndex, elseBranchIndex);
    // The not_attention branch must not push to the transcript, persist a
    // reply, send a contextual update, or return — those all live only in
    // the else branch (verified separately below).
    expect(notAttentionBranch).not.toContain("persistLocalTypedAgentReply");
    expect(notAttentionBranch).not.toContain("sendContextualUpdate");
    expect(notAttentionBranch).not.toContain("sessionTranscriptRef.current.push");
    expect(notAttentionBranch).not.toMatch(/\breturn;/);
  });

  it("[not_attention] ends the active attention context immediately (all four conversation-state refs reset), not merely at session teardown", () => {
    const attentionBlock = blockBetween(
      "if (notAttention) {",
      "} else {",
    );
    expect(attentionBlock).toContain("lastTurnWasAttentionIntentRef.current = false;");
    expect(attentionBlock).toContain("lastAttentionTurnWasGroundedRef.current = false;");
    expect(attentionBlock).toContain("previouslySurfacedEvidenceIdsRef.current = [];");
    expect(attentionBlock).toContain("priorAttentionObjectiveRef.current = null;");
  });

  it("[state accumulation] surfaced evidence ids from a grounded turn are merged (deduped) into the running set, not replaced", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain(
      "new Set([...previouslySurfacedEvidenceIdsRef.current, ...surfacedEvidenceIds])",
    );
  });

  it("[state accumulation] only accumulates/updates state on an actually grounded outcome for this turn, not on the honest-fallback outcome", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    const mergeIndex = attentionBlock.indexOf("const merged = new Set(");
    expect(mergeIndex).toBeGreaterThan(-1);
    const guardSnippet = attentionBlock.slice(Math.max(0, mergeIndex - 450), mergeIndex);
    expect(guardSnippet).toContain('typedGroundingStatus === "grounded"');
  });

  it("does not solve conversational continuation with a new special-cased phrase list — no added regex literals for 'what else'/'which first'/'what can wait' etc. in the typed attention block", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).not.toMatch(/which (one )?should i do first/i);
    expect(attentionBlock).not.toMatch(/what can wait/i);
    expect(attentionBlock).not.toMatch(/only tell me the urgent/i);
  });

  it("does not alter any voice-only (requestedChannel === \"voice\") code path", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).not.toContain('requestedChannel === "voice"');
    expect(attentionBlock).not.toContain("setMicMuted");
  });
});
