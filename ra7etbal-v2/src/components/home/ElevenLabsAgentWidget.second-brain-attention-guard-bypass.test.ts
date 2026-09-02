/**
 * Second Brain Slice 2 — the legacy client-side attention-intent guard
 * (carson-attention-intent-guard.ts) must not compete with the Second
 * Brain server's already-canonical answer. Source-inspection tests,
 * matching this file's existing convention (see
 * ElevenLabsAgentWidget.sdk-config.test.ts,
 * ElevenLabsAgentWidget.second-brain-voice-binding.test.ts) since the
 * component is not unit-rendered anywhere in this repo.
 *
 * Root cause this closes (2026-09-02 live isolated canary): the guard was
 * built for the OLD architecture, where ElevenLabs' hosted model composed
 * replies from client-tool results and could fabricate/omit attention
 * facts. It detects attention intent from the raw utterance independently
 * of which architecture answered the turn, kicks off its OWN client-side
 * re-fetch, and — on the agent turn — unconditionally substitutes either
 * that re-fetch's result or a fixed fallback string for whatever the model
 * (or, for Second Brain turns, our own server) actually said. For a Second
 * Brain turn this raced against and silently overwrote the server's
 * already-correct, already-spoken canonical answer — the exact "no
 * competing response owner" defect this closes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

describe("legacy attention-intent guard is inert for Second Brain voice turns", () => {
  it("gates attentionIntentForCurrentTranscriptRef off entirely when secondBrainVoiceEnabled is true — the single point that controls both the client-side re-fetch and the agent-turn override", () => {
    expect(SOURCE).toContain(
      "attentionIntentForCurrentTranscriptRef.current =\n" +
        "              !secondBrainVoiceEnabled && (matchesAttentionIntent(message) || isAttentionFollowUpTurn);",
    );
  });

  it("the client-side prefetch (fetchAttentionSummary) is reached only through that same ref — no separate secondBrainVoiceEnabled check was duplicated elsewhere, so there is exactly one gate to keep in sync", () => {
    const guardBlock = SOURCE.slice(
      SOURCE.indexOf("attentionIntentForCurrentTranscriptRef.current =\n"),
      SOURCE.indexOf("} else if (role === \"agent\") {"),
    );
    expect(guardBlock).toContain("if (attentionIntentForCurrentTranscriptRef.current) {");
    expect(guardBlock).toContain("fetchAttentionSummary()");
    // Exactly the one occurrence from the ref assignment itself — not a
    // second, independent secondBrainVoiceEnabled check guarding the
    // fetchAttentionSummary() call directly, which could drift out of sync
    // with the ref assignment above.
    expect((guardBlock.match(/secondBrainVoiceEnabled/g) ?? []).length).toBe(1);
  });

  it("resolveAttentionGuardedMessage still receives attentionIntentForCurrentTranscriptRef — the fix is in what that ref evaluates to, not a second bypass around the guard call itself", () => {
    expect(SOURCE).toContain(
      "attentionIntentDetected: attentionIntentForCurrentTranscriptRef.current,",
    );
  });
});
