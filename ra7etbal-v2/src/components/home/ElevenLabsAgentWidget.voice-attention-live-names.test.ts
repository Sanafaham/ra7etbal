/**
 * P3 Step 3 / S3 — legacy voice attention uses live item names. Source-
 * inspection tests, matching this file family's convention (the component is
 * not unit-rendered anywhere in this repo). Behaviour of the renderer and the
 * follow-up recogniser is covered in
 * src/lib/carson-operations-center.voice-live-names.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function between(start: string, end: string): string {
  const from = SOURCE.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = SOURCE.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return SOURCE.slice(from, to);
}

describe("legacy voice attention reads and names live items", () => {
  it("the voice prefetch reads live with this turn's request", () => {
    const prefetch = between("if (attentionIntentForCurrentTranscriptRef.current) {", '} else if (role === "agent") {');
    expect(prefetch).toContain("const requestedView = voiceAttentionChainRef.current.request;");
    expect(prefetch).toContain("fetchVoiceAttentionPresentation(requestedView)");
    expect(prefetch).not.toContain("fetchAttentionPresentation()");
  });

  it("the shared get_items_needing_attention tool uses the voice view only in a voice session; typed keeps the shared counts-only result", () => {
    const tool = between("get_items_needing_attention: (params", "get_commitment_history:");
    expect(tool).toContain(
      'requestedChannel === "voice"\n' +
        "                  ? await fetchVoiceAttentionPresentation(voiceAttentionChainRef.current.request)\n" +
        "                  : await fetchAttentionPresentation();",
    );
  });

  it("an item follow-up is recognised only inside an attention chain, against the people in the last live read", () => {
    const user = between("voiceAttentionChainRef.current = beginVoiceAttentionTurn(", "if (attentionIntentForCurrentTranscriptRef.current) {");
    // P3 Step 3 / S3 (2026-10-10): recognition, the people and the chain now
    // live in beginVoiceAttentionTurn (tested with real reads in
    // src/lib/carson-attention-chain.voice-followup.test.ts).
    expect(user).toContain("utterance: message,");
    const GUARD = readFileSync(join(__dirname, "../../lib/carson-attention-intent-guard.ts"), "utf-8");
    expect(GUARD).toContain("const followUp = contextActive ? resolveVoiceAttentionFollowUp(input.utterance, state.lastAssignees) : null;");
  });

  it("the live read is also given to the voice model, informational only, and never marks captures", () => {
    const prefetch = between("fetchVoiceAttentionPresentation(requestedView)\n", ".catch(() => {");
    // 2026-10-09: a person view is sent too, labelled as that person's items
    // only (the note text lives in fetchVoiceAttentionPresentation). Only a
    // successful read is ever offered.
    expect(prefetch).toContain("if (!presentation.evidenceOk || !presentation.contextNote) return;");
    expect(prefetch).not.toContain('requestedView.kind === "person"');
    expect(prefetch.indexOf("if (!presentation.evidenceOk")).toBeLessThan(prefetch.indexOf("sendContextualUpdate("));
    expect(prefetch).toContain("conversationRef.current?.sendContextualUpdate(presentation.contextNote);");
    expect(prefetch).not.toContain("markAttentionCapturesSurfaced");
  });

  it("the people for a follow-up come only from this session's last grounded voice attention answer, and are cleared with the session", () => {
    // The people come only from a successful read in the current turn
    // (recordVoiceAttentionRead), and the whole chain resets with the session.
    expect(SOURCE).toContain("voiceAttentionChainRef.current = recordVoiceAttentionRead(voiceAttentionChainRef.current, {");
    expect((SOURCE.match(/voiceAttentionChainRef\.current = INITIAL_VOICE_ATTENTION_CHAIN;/g) ?? []).length).toBe(3);
  });

  it("typed is unchanged: the typed /api/carson-turn path never uses the voice renderer or voice follow-up state", () => {
    const typed = between("const isDirectTypedAttentionIntent = matchesAttentionIntent(savedMessage.content);", 'const response = await fetch("/api/carson-turn", {');
    for (const voiceOnly of ["fetchVoiceAttentionPresentation", "voiceAttentionChainRef", "beginVoiceAttentionTurn", "resolveVoiceAttentionFollowUp"]) {
      expect(typed).not.toContain(voiceOnly);
    }
    // Exactly two voice reads: the voice prefetch and the voice branch of the tool.
    expect((SOURCE.match(/fetchVoiceAttentionPresentation\((?:voiceAttentionChainRef\.current\.request|requestedView)\)/g) ?? []).length).toBe(2);
  });
});
