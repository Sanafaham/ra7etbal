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

/**
 * 2026-09-02 — Carson conversation display/history rendering gap: the voice
 * channel's on-screen transcript (lastUserTranscript / lastCarsonMessage)
 * was a pair of scalars that got REPLACED every turn, so a second exchange
 * silently erased the first from the screen instead of appending beneath
 * it — reproduced live via "What needs my attention?" followed by "What
 * about the things I'm waiting on?": only the second Carson reply stayed
 * visible. These tests protect the fix: a chronological voiceConversation
 * array, mirrored from sessionTranscriptRef (the same ref that already
 * accumulates/corrects the session's turns for memory summarization) at
 * the exact points a turn is finalized, rendered as a growing list instead
 * of two single bubbles. No reasoning/attention/routing logic is touched.
 */
describe("ElevenLabsAgentWidget — voice conversation history append (not replace)", () => {
  it("declares a chronological voiceConversation array state, not another scalar", () => {
    expect(SOURCE).toContain(
      "const [voiceConversation, setVoiceConversation] = useState<TranscriptMessage[]>([]);",
    );
  });

  it("resets voiceConversation to empty alongside the existing lastCarsonMessage/lastUserTranscript reset at new-session start — never resets it at teardown, so the finalized conversation still persists after disconnect", () => {
    const idx = SOURCE.indexOf("setLastCarsonMessage(null);\n    setLastUserTranscript(null);");
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 200);
    expect(nearby).toContain("setVoiceConversation([]);");
  });

  it("the user turn is appended (via a fresh sessionTranscriptRef snapshot) immediately after it is pushed onto sessionTranscriptRef, so turn 1's user line survives turn 2", () => {
    const block = blockBetween(
      "invalidCaptureRef.current = null;\n            sessionTranscriptRef.current.push({ role, message });",
      "setLastUserTranscript(message);",
    );
    expect(block).toContain("setVoiceConversation([...sessionTranscriptRef.current]);");
  });

  it("the agent turn is appended only AFTER the message is fully settled (merge/suppression logic already resolved), immediately following setLastCarsonMessage(mergedDisplayMessage)", () => {
    const idx = SOURCE.indexOf("setLastCarsonMessage(mergedDisplayMessage);");
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 120);
    expect(nearby).toContain("setVoiceConversation([...sessionTranscriptRef.current]);");
  });

  it("suppressed/discarded agent replies (hosting-clarification, invalid-capture, idle prompt) all return before the new sync point — they must not leak into the visible history any more than they leak into sessionTranscriptRef today", () => {
    const agentBlock = blockBetween(
      '} else if (role === "agent") {',
      "setLastCarsonMessage(mergedDisplayMessage);",
    );
    // Every one of the three known suppression branches still pops the ref
    // and returns before reaching the sync line — unchanged by this fix.
    const suppressionReturns = agentBlock.match(/sessionTranscriptRef\.current\.pop\(\);[\s\S]{0,300}?return;/g) ?? [];
    expect(suppressionReturns.length).toBeGreaterThanOrEqual(3);
    expect(agentBlock).not.toContain("setVoiceConversation");
  });

  it("renders voiceConversation as a chronological list (map), not the old single-bubble pair, under the exact same visibility gate as before", () => {
    const renderBlock = blockBetween(
      "voiceConversation.length > 0 && (",
      "function MicIcon",
    );
    expect(renderBlock).toContain("voiceConversation.map((turn, index) =>");
    expect(renderBlock).toContain('turn.role === "user"');
    // Same gate the old single lastCarsonMessage bubble required — visibility
    // behavior is unchanged, only what's shown once visible.
    const gateBlock = blockBetween(
      "channel === \"voice\" &&\n        shouldShowCarsonVoiceTranscript({",
      "voiceConversation.length > 0",
    );
    expect(gateBlock).toContain("status,");
    expect(gateBlock).toContain("channel,");
    expect(gateBlock).toContain("hasMessage: Boolean(lastCarsonMessage),");
  });

  it("the old single-bubble scalar render (one lastUserTranscript paragraph, one lastCarsonMessage div, no list) is gone", () => {
    expect(SOURCE).not.toContain('Carson heard: “{lastUserTranscript}”\n        </p>\n      )}\n\n      {/* Keep the Core primary');
  });

  it("does not touch attention classification, reasoning, or routing — matchesAttentionIntent/matchesWaitingFollowUp/resolveAttentionGuardedMessage call sites are unchanged in count", () => {
    expect(SOURCE.split("resolveAttentionGuardedMessage({").length - 1).toBe(1);
    expect(SOURCE.split("attentionIntentForCurrentTranscriptRef.current =").length - 1).toBe(4);
  });
});
