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
 * Production incident (2026-07-06, follow-up to the teardown-guard fix):
 * Carson voice in the iPhone Home Screen PWA stayed INTERMITTENTLY broken —
 * first sessions produced mechanical "printing machine" playback noise and
 * junk transcripts ("...", "Gnaasira" for "Nasira"), while retry sessions
 * worked.
 *
 * Mitigation hypothesis: iOS flips its audio session from playback-only to
 * play-and-record — a route/sample-rate change — the first time the mic is
 * captured. The ElevenLabs SDK captures the mic inside
 * Conversation.startSession and then builds its input/output audio pipeline
 * with ZERO settle delay on iOS (its DEFAULT_DELAY gives android 3000ms and
 * ios nothing), so in a cold standalone PWA the input worklet may start
 * capturing mid-flip and playback may distort. Sana's later production retest
 * still heard printer/machine noise, so this remains a mitigation under test,
 * not a proven complete root cause.
 *
 * Fix (all public API):
 *   1. startCall acquires a warm-up mic stream immediately, inside the
 *      user's tap — the route flip starts at t=0 and settles during the
 *      seconds of memory/context loading that precede startSession.
 *   2. startSession is given connectionDelay { ios: 500 } so the SDK's own
 *      pipeline setup waits out any residual route transition (Android's
 *      3000ms default is preserved).
 *   3. The warm-up stream is released the moment the SDK owns its own
 *      stream, and on every cleanup/error path, so the mic indicator can
 *      never stay stuck on.
 */
describe("ElevenLabsAgentWidget — iOS audio-route warm-up mitigation", () => {
  it("acquires the warm-up mic inside the shared session starter before Conversation.startSession, for voice only", () => {
    const startCallIdx = SOURCE.indexOf(
      'const startCarsonSession = useCallback(async (requestedChannel: CarsonChannel = "voice") => {',
    );
    const warmupIdx = SOURCE.indexOf(
      "navigator.mediaDevices\n            .getUserMedia({ audio: true })",
      startCallIdx,
    );
    const startSessionIdx = SOURCE.indexOf("Conversation.startSession(", startCallIdx);
    expect(startCallIdx).toBeGreaterThan(-1);
    expect(warmupIdx).toBeGreaterThan(startCallIdx);
    expect(startSessionIdx).toBeGreaterThan(warmupIdx);
    const warmupBlock = SOURCE.slice(startCallIdx, startSessionIdx);
    expect(warmupBlock).toContain('requestedChannel === "voice"');
  });

  it("awaits the warm-up before opening the session so startSession never begins mid-route-flip", () => {
    const block = blockBetween(
      "const warmupStream = await micWarmupPromise;",
      "const conv = await Conversation.startSession({",
    );
    expect(block).toContain("if (!isCurrentSession()) return;");
    expect(block).toContain('recordCarsonDiagnostic("carson-audio-warmup", warmupInfo);');
  });

  it("passes connectionDelay with an iOS settle window while preserving Android's 3000ms", () => {
    const optionsBlock = blockBetween(
      "const conv = await Conversation.startSession({",
      "dynamicVariables: {",
    );
    expect(optionsBlock).toContain("connectionDelay: { default: 0, android: 3_000, ios: 500 }");
  });

  it("warm-up failure is non-fatal — the session still starts (SDK requests the mic itself)", () => {
    const kickoffBlock = blockBetween(
      "const micWarmupPromise: Promise<MediaStream | null> =",
      "// Snapshot pending photos NOW",
    );
    expect(kickoffBlock).toContain(".catch((err) => {");
    expect(kickoffBlock).toContain("return null;");
    // Also guards environments without mediaDevices at all.
    expect(kickoffBlock).toContain("navigator.mediaDevices?.getUserMedia");
    expect(kickoffBlock).toContain(": Promise.resolve(null);");
  });

  it("releases the warm-up stream on every exit: after startSession, in the catch, and in forced cleanup", () => {
    // 1. The moment the SDK owns its own stream (covers stale + normal paths,
    //    which both flow through the line right after startSession resolves).
    const afterStart = blockBetween(
      "});\n      // The SDK owns its own mic stream from here",
      "conversationRef.current = conv;",
    );
    expect(afterStart).toContain("releaseMicWarmupStream();");

    // 2. startSession threw.
    const catchBlock = blockBetween(
      "    } catch (err) {\n      releaseMicWarmupStream();",
      "setErrorMsg(`Couldn't connect.",
    );
    expect(catchBlock).toContain("releaseMicWarmupStream();");

    // 3. Every forced-cleanup path (pagehide, timeout, manual end, unmount).
    const cleanupBlock = blockBetween(
      "const forceCleanupSession = useCallback(",
      "if (conv) {",
    );
    expect(cleanupBlock).toContain("releaseMicWarmupStream();");
  });

  it("a warm-up that resolves after the attempt was cancelled self-releases instead of leaking the mic", () => {
    const kickoffBlock = blockBetween(
      "const micWarmupPromise: Promise<MediaStream | null> =",
      "// Snapshot pending photos NOW",
    );
    const thenBlock = blockBetween(
      ".then((stream) => {",
      "micWarmupStreamRef.current = stream;",
    );
    expect(kickoffBlock).toContain("if (!isCurrentSession()) {");
    expect(thenBlock).toContain("track.stop();");
    expect(thenBlock).toContain("return null;");
  });

  it("keeps the previous session-teardown guard intact (this fix is additive, not a replacement)", () => {
    expect(SOURCE).toContain("teardownInFlightRef.current");
    expect(SOURCE).toContain("const endConversationSession = useCallback(");
  });
});
