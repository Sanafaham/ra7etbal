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
 * 2026-08-28 — Second Brain typed hard-grounding boundary, updated for the
 * stateful reasoning admission model (superseding the original follow-up-
 * regex-gated version). Approved boundary: typed user text → app sees it
 * BEFORE ElevenLabs → authenticated server (/api/carson-turn) → mandatory
 * live retrieval → canonical grounded result → display → contextual
 * update for continuity → sendUserMessage() is skipped entirely for this
 * class. Voice is explicitly untouched.
 *
 * Matches this file's existing convention (see typed-mode.test.ts,
 * attention-followup-grounding.test.ts): static source assertions proving
 * shape/ordering, since fully mounting this component with a real
 * ElevenLabs SDK connection isn't practical here.
 */
describe("ElevenLabsAgentWidget — typed attention hard-grounding boundary", () => {
  it("classifies the typed message before ever reaching sendUserMessage — direct match OR active grounded context, never a growing regex", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const classifyIndex = sendBlock.indexOf("const isDirectTypedAttentionIntent =");
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");
    expect(classifyIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(classifyIndex).toBeLessThan(sendIndex);

    expect(sendBlock).toContain("matchesAttentionIntent(savedMessage.content)");
    expect(sendBlock).toContain(
      "lastTurnWasAttentionIntentRef.current && lastAttentionTurnWasGroundedRef.current",
    );
  });

  it("never lets sendUserMessage run for an admitted, non-not_attention turn — the block returns before it", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain("if (typedAttentionCandidate) {");
    expect(attentionBlock).not.toContain("conversation.sendUserMessage");
    const ifIndex = attentionBlock.indexOf("if (typedAttentionCandidate) {");
    const returnIndex = attentionBlock.indexOf("return;", ifIndex);
    expect(returnIndex).toBeGreaterThan(ifIndex);
  });

  it("authenticates with the caller's own session JWT — never a service-role or hardcoded token", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain("await supabase.auth.getSession()");
    expect(attentionBlock).toContain("attentionSessionData?.session?.access_token");
    expect(attentionBlock).toContain("authorization: `Bearer ${attentionJwt}`");
    expect(attentionBlock).not.toMatch(/service.?role/i);
  });

  it("calls the server-owned Carson turn endpoint, not a client-composed answer", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain('fetch("/api/carson-turn"');
  });

  it("fails closed to the honest grounding-unavailable message by default — only overwritten on an actual handled response", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain("let ownerResult: string = ATTENTION_GROUNDING_UNAVAILABLE_MESSAGE;");
    const tryIndex = attentionBlock.indexOf("try {");
    const catchIndex = attentionBlock.indexOf("} catch {");
    expect(tryIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeGreaterThan(tryIndex);
  });

  it("sends the contextual update for continuity only after the canonical reply is already persisted, and only informs — never re-asks", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    const persistIndex = attentionBlock.indexOf("await persistLocalTypedAgentReply({");
    const contextualIndex = attentionBlock.indexOf("conversationRef.current?.sendContextualUpdate(");
    expect(persistIndex).toBeGreaterThan(-1);
    expect(contextualIndex).toBeGreaterThan(persistIndex);
    expect(attentionBlock).toContain("do not re-answer, re-check, or reference searching/checking anything");
  });

  it("marks a handled (non-not_attention) turn as attention-intent for the shared continuation gate, same lifecycle as voice", () => {
    const attentionBlock = blockBetween(
      "const isDirectTypedAttentionIntent =",
      "// Final deterministic gate before the free-form typed model ever runs.",
    );
    expect(attentionBlock).toContain("lastTurnWasAttentionIntentRef.current = true;");
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
