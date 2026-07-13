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
 * Production incident (2026-07-06/07, third round — follow-up to the
 * teardown-guard fix (9562d65) and the iOS audio-route warm-up mitigation
 * (1e02bd7)): both were real fixes for real bugs, but Carson voice on the
 * iPhone Home Screen PWA stayed corrupted — mechanical "printing machine"
 * noise during Carson's speech, and clipped/junk transcripts at the start
 * of the user's turn ("...", "Ask Suresh to call me" heard as "Call me").
 *
 * Root cause identified by incident review: onModeChange called
 * `conversationRef.current?.setMicMuted(m === "speaking")` on EVERY
 * speaking<->listening transition — i.e. continuously, all session long,
 * not just at session start (which is why the start-time fixes above did
 * not resolve it). On the WebRTC/LiveKit transport this SDK call can mute
 * *and re-acquire* the underlying microphone track (the SDK's own source
 * notes it may replace the MediaStreamTrack on unmute). On iOS that forces
 * an audio-unit route reconfiguration on every single turn boundary:
 *   - reconfiguring while Carson's own audio is playing -> clicks/pops
 *     ("printing machine" noise), and
 *   - a capture dead-window right as the user starts replying -> clipped
 *     utterance heads ("...", "Call me" instead of "Ask Suresh to call me").
 * The very first symptom ever reported — "Failed to set input muted
 * state" — was this exact call throwing, on this exact hot path.
 *
 * Confirmed on-device after removal: Carson correctly heard "Ask Suresh to
 * call me" and the delegation sent. This suite locks in the removal so it
 * can never be silently reintroduced.
 */
describe("ElevenLabsAgentWidget — no app-level half-duplex mic muting", () => {
  it("never calls setMicMuted from onModeChange — WebRTC/LiveKit runs full-duplex on its own", () => {
    const modeChangeBlock = blockBetween(
      "onModeChange: ({ mode: m }) => {",
      "        onMessage: ({ role, message, event_id }) => {",
    );
    expect(modeChangeBlock).not.toContain(".setMicMuted(");
    expect(modeChangeBlock).not.toContain("conversationRef.current?.setMicMuted");
  });

  it("removed the dead mic-mute-error diagnostic branch along with the call it guarded", () => {
    expect(SOURCE).not.toContain('phase: "mic_mute_error"');
    expect(SOURCE).not.toContain("failed to update microphone mute state");
  });

  it("onModeChange still tracks latency and sets local UI mode — only the mute call was removed", () => {
    const modeChangeBlock = blockBetween(
      "onModeChange: ({ mode: m }) => {",
      "        onMessage: ({ role, message, event_id }) => {",
    );
    expect(modeChangeBlock).toContain('recordCarsonDiagnostic("carson-audio-session", modeInfo);');
    expect(modeChangeBlock).toContain("activeExecuteLatencyRef.current");
    expect(modeChangeBlock).toContain('setMode(m === "speaking" ? "speaking" : "listening");');
  });

  it("the only remaining raw setMicMuted calls are one-time mutes right before endSession during teardown, not per-turn", () => {
    // Exactly two raw .setMicMuted( calls in the whole file: one inside the
    // shared muteConversationBeforeTeardown helper (used by the normal
    // teardown path), and one in the stale-connection-cleanup branch of
    // startCall (deliberately not routed through the shared helper — see
    // that branch's own comment). Neither is reachable from onModeChange.
    expect(SOURCE.split(".setMicMuted(true)").length - 1).toBe(2);

    const helperBlock = blockBetween(
      "const muteConversationBeforeTeardown = useCallback(",
      "const endConversationSession = useCallback(",
    );
    expect(helperBlock.split(".setMicMuted(true)").length - 1).toBe(1);

    const staleCleanupBlock = blockBetween(
      '"[carson-lifecycle] stale connection cleaned up"',
      "endConversationSession(conv,",
    );
    expect(staleCleanupBlock.split(".setMicMuted(true)").length - 1).toBe(1);
  });

  it("forceCleanupSession mutes only voice through the shared helper immediately before ending the session", () => {
    const conclusionBlock = blockBetween(
      "if (conv) {\n        if (activeChannelRef.current === \"voice\") {",
      "      if (activeChannelRef.current === \"voice\") {\n        stopLocalAudioPlayback();",
    );
    expect(conclusionBlock).toContain("muteConversationBeforeTeardown(conv, teardownReason);");
    expect(conclusionBlock).toContain("endConversationSession(conv,");
  });

  it("counts every legitimate mute call per session and would flag a second one as an anomaly", () => {
    const helperBlock = blockBetween(
      "const muteConversationBeforeTeardown = useCallback(",
      "const endConversationSession = useCallback(",
    );
    expect(helperBlock).toContain("micMuteCallCountRef.current += 1;");
    expect(helperBlock).toContain("if (micMuteCallCountRef.current > 1) {");
    expect(helperBlock).toContain('phase: "mic_mute_anomaly"');
    // Reset once per new session, alongside the other per-session counters —
    // otherwise a legitimate mute from a PREVIOUS session would falsely trip
    // the anomaly check on session two.
    expect(SOURCE).toContain("micMuteCallCountRef.current = 0;");
  });
});
