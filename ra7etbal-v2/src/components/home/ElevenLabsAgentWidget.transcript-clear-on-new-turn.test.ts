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
 * 2026-08-25 production incident (post-PR #331): production diagnostics
 * proved ElevenLabs' "speaking" vs "agent_message" event order is not
 * universal — tool-invoking turns (send_delegation, create_reminder)
 * delivered agent_message BEFORE speaking (eventIds 137, 269), the inverse
 * of the non-tool ordering PR #331 assumed. The widget now delegates the
 * clear/display decision to the tested pure state machine in
 * carson-transcript-turn-state.ts instead of inferring it from event
 * order with a boolean. These tests verify the WIDGET's wiring to that
 * state machine; the state machine's own behavior across both event
 * orderings is covered exhaustively in carson-transcript-turn-state.test.ts.
 */
describe("ElevenLabsAgentWidget — Carson transcript turn-state wiring", () => {
  it("imports reduceCarsonTranscriptTurn from the tested state-machine module", () => {
    expect(SOURCE).toContain(
      'import { reduceCarsonTranscriptTurn, type CarsonTranscriptTurnState } from "../../lib/carson-transcript-turn-state";',
    );
  });

  it("declares a dedicated ref holding the state-machine's state, not a boolean", () => {
    expect(SOURCE).toContain(
      'const carsonTranscriptTurnStateRef = useRef<CarsonTranscriptTurnState>("pending");',
    );
  });

  it("onModeChange's speaking branch dispatches a 'speaking' event through the reducer and only applies display when the reducer returns one", () => {
    const modeChangeBlock = blockBetween(
      'onModeChange: ({ mode: m }) => {',
      "setMode(m === \"speaking\" ? \"speaking\" : \"listening\");",
    );
    expect(modeChangeBlock).toContain(
      'reduceCarsonTranscriptTurn(carsonTranscriptTurnStateRef.current, {\n              type: "speaking",\n            })',
    );
    expect(modeChangeBlock).toMatch(
      /carsonTranscriptTurnStateRef\.current = speakingResult\.state;\s*\n\s*if \(speakingResult\.display !== undefined\)\s*{\s*setLastCarsonMessage\(speakingResult\.display\);/,
    );
  });

  it("never replaces the cleared transcript with placeholder or narration text in the speaking branch", () => {
    const clearSnippet = blockBetween(
      "const speakingResult = reduceCarsonTranscriptTurn(",
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
    // The only setLastCarsonMessage call in this snippet must pass exactly
    // the reducer's own display value — never a literal string.
    const setCalls = clearSnippet.match(/setLastCarsonMessage\(([^)]*)\)/g) ?? [];
    expect(setCalls).toEqual(["setLastCarsonMessage(speakingResult.display)"]);
  });

  it("the agent_message handler dispatches an 'agent_message' event through the reducer BEFORE calling setLastCarsonMessage, so a racing speaking transition can never see stale state", () => {
    const idx = SOURCE.indexOf("carsonTranscriptTurnStateRef.current = reduceCarsonTranscriptTurn(");
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 400);
    expect(nearby).toContain('{ type: "agent_message", text: finalDisplayMessage }');
    const setIdx = nearby.indexOf("setLastCarsonMessage(finalDisplayMessage);");
    const stateIdx = nearby.indexOf("carsonTranscriptTurnStateRef.current = reduceCarsonTranscriptTurn(");
    expect(setIdx).toBeGreaterThan(stateIdx);
  });

  it("resets the ref to 'pending' exactly once per new user turn (role === \"user\" branch), alongside the existing toolRanForCurrentTranscriptRef per-turn reset", () => {
    const idx = SOURCE.indexOf("turnLatencyLoggedForEventIdRef.current = null;\n            toolRanForCurrentTranscriptRef.current = false;");
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 400);
    expect(nearby).toContain('carsonTranscriptTurnStateRef.current = "pending";');
  });

  it("resets the ref to 'pending' at every session-boundary reset site (teardown, onDisconnect, onError) so it can never leak into the next session", () => {
    const resetCount = SOURCE.split('carsonTranscriptTurnStateRef.current = "pending";').length - 1;
    // Session-boundary resets (3) + the one per-turn reset already asserted
    // above = 4 total occurrences of this exact reset line in the file.
    expect(resetCount).toBe(SESSION_BOUNDARY_RESET_COUNT + 1);
  });

  it("the real agent_response transcript continues to flow through the existing, unmodified display pipeline (resolveAttentionGuardedMessage -> resolveSanitizedCarsonDisplayMessage -> resolveConsequentialOwnerMessage -> setLastCarsonMessage)", () => {
    expect(SOURCE).toContain("setLastCarsonMessage(finalDisplayMessage)");
  });

  it("no boolean carsonTranscriptClearedForTurnRef remains anywhere in the file", () => {
    expect(SOURCE).not.toContain("carsonTranscriptClearedForTurnRef");
  });
});
