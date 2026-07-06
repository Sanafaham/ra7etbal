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

function countOccurrences(needle: string): number {
  return SOURCE.split(needle).length - 1;
}

/**
 * Production incident (2026-07-06): Carson voice reported mechanical
 * "printing machine" noise, garbled/one-word transcripts, and a
 * "Failed to set input muted state" error — specifically after adding
 * Ra7etBal to the iPhone Home Screen (standalone PWA).
 *
 * Root cause: forceCleanupSession() cleared conversationRef.current and
 * flipped status back to "idle" synchronously, then called
 * conv.endSession() as fire-and-forget (never awaited). startCall()'s
 * guard against a second session only checked conversationRef.current and
 * status — both already cleared the instant cleanup began, before the
 * real WebRTC/mic teardown had finished. iOS standalone PWA mode fires
 * pagehide/visibilitychange (which trigger this same cleanup path) more
 * aggressively than a regular Safari tab, so a user could tap "Talk to
 * Carson" again right after a spurious forced-disconnect and open a
 * second live mic/WebRTC session while the first was still tearing down
 * — two overlapping audio sessions on one microphone.
 *
 * Fix: teardownInFlightRef, set the instant a previous session's
 * endSession() is kicked off and cleared only once it actually settles
 * (with a safety timeout so a hung promise can't permanently block
 * reconnecting). startCall()'s guard now also blocks while a teardown is
 * in flight. Both teardown call sites route through one shared
 * endConversationSession() helper — no parallel/duplicate teardown logic.
 */
describe("ElevenLabsAgentWidget — session teardown guard (Carson voice race-condition fix)", () => {
  it("declares teardownInFlightRef, defaulted to false, alongside the other session refs", () => {
    expect(SOURCE).toContain("const teardownInFlightRef = useRef(false);");
  });

  it("startCall's reconnect guard blocks while a previous session's teardown is still in flight", () => {
    const guardBlock = blockBetween(
      "const startCall = useCallback(async () => {\n    if (!agentId) return;\n    if (",
      "      console.warn(\"[carson-lifecycle] reconnect attempt blocked\"",
    );
    expect(guardBlock).toContain("startInFlightRef.current ||");
    expect(guardBlock).toContain('statusRef.current !== "idle" ||');
    expect(guardBlock).toContain("conversationRef.current ||");
    expect(guardBlock).toContain("teardownInFlightRef.current");
  });

  it("evaluates the real guard expression (byte-for-byte from source): blocked only when a flag is set, clear when idle", () => {
    // Extract the literal boolean expression startCall actually guards on, so
    // this test fails if a future edit ever drops teardownInFlightRef (or any
    // other flag) from the real condition — not a hand-copied approximation.
    const exprBlock = blockBetween(
      "    if (\n      startInFlightRef.current ||",
      "\n    ) {",
    );
    const expression = "startInFlightRef.current ||" + exprBlock.split("startInFlightRef.current ||")[1];

    function evalGuard(refs: {
      startInFlight: boolean;
      status: "idle" | "connecting" | "connected" | "error";
      hasConversation: boolean;
      teardownInFlight: boolean;
    }): boolean {
      const startInFlightRef = { current: refs.startInFlight };
      const statusRef = { current: refs.status };
      const conversationRef = { current: refs.hasConversation ? {} : null };
      const teardownInFlightRef = { current: refs.teardownInFlight };
      // eslint-disable-next-line no-new-func
      return new Function(
        "startInFlightRef",
        "statusRef",
        "conversationRef",
        "teardownInFlightRef",
        `return Boolean(${expression});`,
      )(startInFlightRef, statusRef, conversationRef, teardownInFlightRef);
    }

    // Normal idle state — nothing in flight — must NOT be blocked (start still works).
    expect(
      evalGuard({ startInFlight: false, status: "idle", hasConversation: false, teardownInFlight: false }),
    ).toBe(false);

    // The exact regression: a previous session's teardown is still in flight,
    // even though status and conversationRef already look "safe" to restart.
    expect(
      evalGuard({ startInFlight: false, status: "idle", hasConversation: false, teardownInFlight: true }),
    ).toBe(true);

    // Existing guards still hold.
    expect(
      evalGuard({ startInFlight: true, status: "idle", hasConversation: false, teardownInFlight: false }),
    ).toBe(true);
    expect(
      evalGuard({ startInFlight: false, status: "connecting", hasConversation: false, teardownInFlight: false }),
    ).toBe(true);
    expect(
      evalGuard({ startInFlight: false, status: "idle", hasConversation: true, teardownInFlight: false }),
    ).toBe(true);
  });

  it("endConversationSession holds teardownInFlightRef for the real endSession() call, with a safety timeout", () => {
    const helperBlock = blockBetween(
      "const endConversationSession = useCallback(",
      "  const forceCleanupSession = useCallback(",
    );
    expect(helperBlock).toContain("teardownInFlightRef.current = true;");
    expect(helperBlock).toContain("teardownSafetyTimerRef.current = setTimeout(() => {");
    expect(helperBlock).toContain("teardownInFlightRef.current = false;");
    expect(helperBlock).toContain(".endSession()");
    expect(helperBlock).toContain(".finally(() => {");
  });

  it("both teardown call sites route through the single shared endConversationSession helper — no parallel teardown logic", () => {
    expect(countOccurrences("endConversationSession(conv,")).toBe(2);
    // Exactly one real .endSession() call in the whole file — inside the
    // shared helper only. If this ever grows, a call site has started
    // tearing a session down on its own instead of using the shared guard.
    expect(countOccurrences(".endSession()")).toBe(1);
  });

  it("startSession is opened from exactly one place — no duplicate/parallel session-start path can exist", () => {
    expect(countOccurrences("Conversation.startSession(")).toBe(1);
  });

  it("normal start still proceeds past the guard when nothing is in flight (startInFlightRef flips true immediately after)", () => {
    const afterGuardBlock = blockBetween(
      "      return;\n    }\n\n    startInFlightRef.current = true;",
      "const sessionGeneration = sessionGenerationRef.current + 1;",
    );
    expect(afterGuardBlock).toContain("startInFlightRef.current = true;");
  });

  it("stopSession/endCall still tear down through forceCleanupSession — the normal manual-stop path is unchanged", () => {
    expect(SOURCE).toContain(
      'const stopSession = useCallback((teardownReason: string = "manual-end") => {\n    forceCleanupSession(teardownReason);',
    );
    expect(SOURCE).toContain(
      'const endCall = useCallback(() => stopSession("manual-end-button"), [stopSession]);',
    );
  });
});
