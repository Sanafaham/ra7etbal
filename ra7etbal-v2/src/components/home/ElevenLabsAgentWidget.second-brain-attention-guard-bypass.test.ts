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
    // P3 Step 3 / S3 (2026-10-10): the same single gate, now passed to
    // beginVoiceAttentionTurn, which recognises nothing when disabled.
    expect(SOURCE).toContain("enabled: !secondBrainVoiceEnabled,");
    expect(SOURCE).toContain(
      "attentionIntentForCurrentTranscriptRef.current = voiceAttentionChainRef.current.recognised;",
    );
    const GUARD = readFileSync(join(__dirname, "../../lib/carson-attention-intent-guard.ts"), "utf-8");
    expect(GUARD).toContain('if (!input.enabled) return { ...base, request: { kind: "summary" }, recognised: false };');
  });

  it("the client-side prefetch (fetchAttentionPresentation) is reached only through that same ref — no separate secondBrainVoiceEnabled check was duplicated elsewhere, so there is exactly one gate to keep in sync", () => {
    const guardBlock = SOURCE.slice(
      SOURCE.indexOf("voiceAttentionChainRef.current = beginVoiceAttentionTurn("),
      SOURCE.indexOf("} else if (role === \"agent\") {"),
    );
    expect(guardBlock).toContain("if (attentionIntentForCurrentTranscriptRef.current) {");
    expect(guardBlock).toContain("fetchVoiceAttentionPresentation(requestedView)");
    // Exactly the one occurrence from the ref assignment itself — not a
    // second, independent secondBrainVoiceEnabled check guarding the
    // fetchAttentionPresentation() call directly, which could drift out of sync
    // with the ref assignment above.
    expect((guardBlock.match(/secondBrainVoiceEnabled/g) ?? []).length).toBe(1);
  });

  it("resolveAttentionGuardedMessage still receives attentionIntentForCurrentTranscriptRef — the fix is in what that ref evaluates to, not a second bypass around the guard call itself", () => {
    expect(SOURCE).toContain(
      "attentionIntentDetected: attentionIntentForCurrentTranscriptRef.current,",
    );
  });
});
