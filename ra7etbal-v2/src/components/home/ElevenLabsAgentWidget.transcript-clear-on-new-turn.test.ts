import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

const SESSION_BOUNDARY_RESET_COUNT = 3; // teardown, onDisconnect, onError

/**
 * 2026-08-25 production investigation: ElevenLabs sends the "audio" event
 * (which drives mode: "speaking") before the "agent_response" event (which
 * drives onMessage -> setLastCarsonMessage) for every voice turn — proven
 * from official ElevenLabs docs and the installed @elevenlabs/client SDK
 * source (VoiceConversation.js's handleAudio calls updateMode("speaking")
 * directly, independent of agent_response). Result: the visible Carson text
 * bubble kept showing the PREVIOUS turn's text while audibly speaking a NEW
 * one, until the new agent_response event finally arrived. Fix: clear the
 * stale transcript once, at the genuine start of a new turn's speech —
 * never replaced with placeholder/generated text, never cleared repeatedly
 * for the same turn's multi-sentence audio chunks.
 */
describe("ElevenLabsAgentWidget — clear stale Carson transcript at new-turn speech boundary", () => {
  it("declares a dedicated ref for turn-scoped clear-once tracking", () => {
    expect(SOURCE).toContain("const carsonTranscriptClearedForTurnRef = useRef(false);");
  });

  it("clears lastCarsonMessage inside onModeChange's speaking branch, gated on the ref not already being set", () => {
    const modeChangeBlock = blockBetween(
      'onModeChange: ({ mode: m }) => {',
      "setMode(m === \"speaking\" ? \"speaking\" : \"listening\");",
    );
    expect(modeChangeBlock).toMatch(
      /if \(!carsonTranscriptClearedForTurnRef\.current\)\s*{\s*carsonTranscriptClearedForTurnRef\.current = true;\s*setLastCarsonMessage\(null\);/,
    );
  });

  it("never replaces the cleared transcript with placeholder or narration text — only null", () => {
    // Scoped to just the new clear-once snippet, not the whole surrounding
    // onModeChange function — that function's pre-existing, unrelated
    // turnPhase label logic legitimately uses words like "Thinking" for a
    // completely different UI element (the turn-phase spinner label), which
    // would otherwise false-positive this check.
    const clearSnippet = blockBetween(
      "if (!carsonTranscriptClearedForTurnRef.current) {",
      "const active = activeExecuteLatencyRef.current;",
    );
    const banned = [
      "One moment",
      "Carson is responding",
      "Checking",
      "Thinking",
      "Please wait",
      "Let me",
    ];
    for (const phrase of banned) {
      expect(clearSnippet).not.toContain(phrase);
    }
    // The only setLastCarsonMessage call in this snippet must pass exactly null.
    const setCalls = clearSnippet.match(/setLastCarsonMessage\(([^)]*)\)/g) ?? [];
    expect(setCalls).toEqual(["setLastCarsonMessage(null)"]);
  });

  it("the clear-once guard is inside the existing m === \"speaking\" branch — not a new top-level branch, and not touching the listening/turnPhase-reset branch", () => {
    const modeChangeBlock = blockBetween(
      'onModeChange: ({ mode: m }) => {',
      "setMode(m === \"speaking\" ? \"speaking\" : \"listening\");",
    );
    const speakingBranchStart = modeChangeBlock.indexOf('if (m === "speaking") {');
    const clearIndex = modeChangeBlock.indexOf("carsonTranscriptClearedForTurnRef.current = true;");
    const elseBranchStart = modeChangeBlock.indexOf("} else {");
    expect(speakingBranchStart).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(speakingBranchStart);
    expect(elseBranchStart).toBeGreaterThan(clearIndex);
  });

  it("resets the ref exactly once per new user turn (role === \"user\" branch), alongside the existing toolRanForCurrentTranscriptRef per-turn reset", () => {
    const idx = SOURCE.indexOf("turnLatencyLoggedForEventIdRef.current = null;\n            toolRanForCurrentTranscriptRef.current = false;");
    // Locate the specific per-turn reset site (inside role === "user"
    // processing, 12-space indent) rather than the 6-space teardown site or
    // the 10-space onDisconnect/onError sites, by anchoring on this file's
    // known unique per-turn neighbor line.
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 400);
    expect(nearby).toContain("carsonTranscriptClearedForTurnRef.current = false;");
  });

  it("resets the ref at every session-boundary reset site (teardown, onDisconnect, onError) so it can never leak into the next session", () => {
    const resetCount = SOURCE.split("carsonTranscriptClearedForTurnRef.current = false;").length - 1;
    // Session-boundary resets (3) + the one per-turn reset already asserted
    // above = 4 total occurrences of this exact reset line in the file.
    expect(resetCount).toBe(SESSION_BOUNDARY_RESET_COUNT + 1);
  });

  it("the real agent_response transcript continues to flow through the existing, unmodified display pipeline (resolveAttentionGuardedMessage -> resolveSanitizedCarsonDisplayMessage -> resolveConsequentialOwnerMessage -> setLastCarsonMessage)", () => {
    expect(SOURCE).toContain("setLastCarsonMessage(finalDisplayMessage)");
  });
});
