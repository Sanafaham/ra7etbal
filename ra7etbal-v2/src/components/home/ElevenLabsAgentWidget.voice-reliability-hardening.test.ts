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
 * Ra7etBal Reliability First Engineering — Carson Voice hardening.
 *
 * Converts the half-duplex-mute incident into permanent operational
 * protection: three independent regression detectors that would have
 * surfaced the original bug class in production diagnostics long before a
 * user noticed audio corruption, plus a defense-in-depth checkpoint for the
 * teardown-race bug from the round before it. None of these change any
 * user-facing behavior — they only observe and record.
 */
describe("ElevenLabsAgentWidget — voice reliability hardening", () => {
  it("mic-mute anomaly detector: exactly one legitimate setMicMuted call is expected per session; a second is flagged", () => {
    expect(SOURCE).toContain("const micMuteCallCountRef = useRef(0);");
    const helperBlock = blockBetween(
      "const muteConversationBeforeTeardown = useCallback(",
      "const endConversationSession = useCallback(",
    );
    expect(helperBlock).toContain("micMuteCallCountRef.current += 1;");
    expect(helperBlock).toContain("if (micMuteCallCountRef.current > 1) {");
    expect(helperBlock).toContain('phase: "mic_mute_anomaly"');
    expect(helperBlock).toContain('recordCarsonDiagnostic("carson-audio-session"');
    // Reset every new session so a stale count from a previous call can never
    // cause a false-positive anomaly on the next one.
    const resetBlock = blockBetween(
      "// Reset session state for this new session.",
      "// Load structured user memory",
    );
    expect(resetBlock).toContain("micMuteCallCountRef.current = 0;");
  });

  it("session-churn detector: a non-user-initiated teardown within 4s of connect is flagged, and covers all three real disconnect paths", () => {
    expect(SOURCE).toContain("const sessionConnectedAtRef = useRef<number | null>(null);");
    const churnHelperBlock = blockBetween(
      "const checkForSessionChurn = useCallback((teardownReason: string) => {",
      "const forceCleanupSession = useCallback(",
    );
    expect(churnHelperBlock).toContain('teardownReason === "manual-end"');
    expect(churnHelperBlock).toContain('teardownReason === "manual-end-button"');
    expect(churnHelperBlock).toContain("durationMs < 4_000");
    expect(churnHelperBlock).toContain('phase: "short_session"');
    // sessionConnectedAtRef is always cleared, short session or not — a
    // stale timestamp must never leak into the next session's measurement.
    expect(churnHelperBlock).toContain("sessionConnectedAtRef.current = null;");

    // All three code paths that can actually end a session call the shared
    // detector — not just forceCleanupSession. onDisconnect/onError run their
    // own inline cleanup (they don't call forceCleanupSession), so without
    // this the most common real disconnect path would silently skip the check.
    expect(countOccurrences("checkForSessionChurn(")).toBe(3); // 3 call sites (definition uses "= useCallback(", not this exact substring)
    expect(SOURCE).toContain("checkForSessionChurn(teardownReason);");
    expect(SOURCE).toContain("checkForSessionChurn(disconnectInfo.reason);");
    expect(SOURCE).toContain('checkForSessionChurn("sdk-error");');

    // Stamped at connect, read at every teardown path.
    expect(SOURCE).toContain("sessionConnectedAtRef.current = performance.now();");
    const onConnectBlock = blockBetween("onConnect: () => {", "onConversationMetadata:");
    expect(onConnectBlock).toContain("sessionConnectedAtRef.current = performance.now();");
  });

  it("duplicate-session defense in depth: a second checkpoint right before the one real startSession call, independent of the entry guard", () => {
    const preStartBlock = blockBetween(
      'phase: "before_start_session"',
      "const conv = await Conversation.startSession({",
    );
    expect(preStartBlock).toContain("if (conversationRef.current) {");
    expect(preStartBlock).toContain('phase: "duplicate_session_blocked"');
    expect(preStartBlock).toContain("releaseMicWarmupStream();");
    expect(preStartBlock).toContain("startInFlightRef.current = false;");
    expect(preStartBlock).toContain("return;");
    // This is a SECOND, independent checkpoint — the original entry guard in
    // startCall's early-return must still be present too.
    expect(SOURCE).toContain("teardownInFlightRef.current");
  });

  it("transcript-quality counter: every rejected capture is counted per session and included in the disconnect/error diagnostics", () => {
    expect(SOURCE).toContain("const invalidCaptureCountRef = useRef(0);");
    expect(SOURCE).toContain("invalidCaptureCountRef.current += 1;");
    expect(SOURCE).toContain("invalidCaptureCountRef.current = 0;");
    expect(SOURCE).toContain("sessionInvalidCaptureCount: invalidCaptureCountRef.current");
    // Surfaced in both real end-of-session diagnostic events, not just logged
    // silently — otherwise a session full of failed captures looks identical
    // to a clean one in the diagnostics buffer.
    const disconnectDiagBlock = blockBetween(
      'phase: "disconnect"',
      "checkForSessionChurn(disconnectInfo.reason);",
    );
    expect(disconnectDiagBlock).toContain("invalidCaptureCount: invalidCaptureCountRef.current");
    const errorDiagBlock = blockBetween(
      'phase: "error"',
      'checkForSessionChurn("sdk-error");',
    );
    expect(errorDiagBlock).toContain("invalidCaptureCount: invalidCaptureCountRef.current");
  });

  it("still only one Conversation.startSession and one real .endSession() call — hardening did not introduce a parallel path", () => {
    expect(countOccurrences("Conversation.startSession(")).toBe(1);
    expect(countOccurrences(".endSession()")).toBe(1);
  });

  it("new diagnostic phases are recorded through the single existing recordCarsonDiagnostic sink, not a new buffer", () => {
    const newPhases = [
      "mic_mute_anomaly",
      "short_session",
      "duplicate_session_blocked",
    ];
    for (const phase of newPhases) {
      const idx = SOURCE.indexOf(`phase: "${phase}"`);
      expect(idx).toBeGreaterThan(-1);
      // Every one of these phases is passed as the payload to
      // recordCarsonDiagnostic("carson-audio-session", ...) — confirm the
      // call appears in the surrounding ~200 chars rather than requiring a
      // brand-new diagnostic kind/sink.
      const surrounding = SOURCE.slice(Math.max(0, idx - 200), idx);
      expect(surrounding).toContain('recordCarsonDiagnostic("carson-audio-session"');
    }
  });
});
