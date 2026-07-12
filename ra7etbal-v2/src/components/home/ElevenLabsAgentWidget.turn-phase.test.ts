import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 1 of the Carson voice reliability work: a truthful intermediate
 * processing state (Listening → Heard you → Thinking → Acting → Speaking)
 * so the user never wonders whether Carson disconnected after they finish
 * speaking, plus latency instrumentation for tool-free turns. Every state
 * here is source-pattern-tested against ElevenLabsAgentWidget.tsx,
 * consistent with how this ~5000-line component is tested throughout this
 * file family (no full render harness).
 *
 * Explicitly out of scope for this phase: microphone constraints
 * (echoCancellation/noiseSuppression/autoGainControl/sampleRate/
 * channelCount) and any ElevenLabs SDK audio configuration — not touched.
 */
const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

describe("ElevenLabsAgentWidget — CarsonTurnPhase type and no microphone changes", () => {
  it("defines the truthful CarsonTurnPhase states", () => {
    expect(SOURCE).toContain(
      'type CarsonTurnPhase = "idle" | "heard" | "thinking" | "acting";',
    );
  });

  it("does not add or change microphone audio constraints in this phase", () => {
    expect(SOURCE).not.toMatch(/echoCancellation/);
    expect(SOURCE).not.toMatch(/noiseSuppression/);
    expect(SOURCE).not.toMatch(/autoGainControl/);
    // sampleRate/channelCount as getUserMedia constraints — the diagnostic
    // packet's string label "sdk-default" is unrelated and must remain.
    expect(SOURCE).toContain('sampleRate: "sdk-default"');
  });
});

describe("ElevenLabsAgentWidget — final transcript changes UI to Heard you / Thinking", () => {
  function onMessageUserBlock(): string {
    const start = SOURCE.indexOf("invalidCaptureRef.current = null;\n            sessionTranscriptRef.current.push");
    const end = SOURCE.indexOf("if (detectAllRecurringSchedules(message).length > 0)", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("sets turnPhase to heard immediately on a valid final transcript, with no delay before that", () => {
    const block = onMessageUserBlock();
    expect(block).toContain('setTurnPhase("heard");');
    // No delay before "heard" itself — the timer only exists to flip the
    // label onward to "thinking", not to gate showing "heard" at all.
    const heardIndex = block.indexOf('setTurnPhase("heard");');
    const timeoutIndex = block.indexOf("turnPhaseThinkingTimeoutRef.current = setTimeout(");
    expect(timeoutIndex).toBeGreaterThan(heardIndex);
  });

  it("only flips heard -> thinking via the timer, never overwriting a phase that already moved on (acting/idle)", () => {
    const block = onMessageUserBlock();
    expect(block).toMatch(
      /setTurnPhase\(\(prev\) => \(prev === "heard" \? "thinking" : prev\)\);/,
    );
  });

  it("does not set heard/thinking for an invalid (non-user) capture — the transition sits after the invalid-capture early return", () => {
    const start = SOURCE.indexOf("if (!captureEvaluation.valid) {");
    const earlyReturn = SOURCE.indexOf("return;", start);
    const heardSet = SOURCE.indexOf('setTurnPhase("heard");', start);
    expect(start).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(start);
    expect(heardSet).toBeGreaterThan(earlyReturn);
  });
});

describe("ElevenLabsAgentWidget — tool start changes UI to Acting, tool end/failure never leaves it stuck", () => {
  function runDirectToolWithDiagnosticBlock(): string {
    const start = SOURCE.indexOf("const runDirectToolWithDiagnostic = useCallback(");
    const end = SOURCE.indexOf("const guardCurrentVoiceCapture = useCallback(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("sets Acting before the tool runs, for every tool that shares this wrapper (the majority of client tools)", () => {
    const block = runDirectToolWithDiagnosticBlock();
    const setActingIndex = block.indexOf('setTurnPhase("acting");');
    const tryIndex = block.indexOf("try {", setActingIndex);
    expect(setActingIndex).toBeGreaterThan(-1);
    expect(tryIndex).toBeGreaterThan(setActingIndex);
  });

  it("clears Acting in a finally block, so a thrown tool error still clears it — never stuck on Acting", () => {
    const block = runDirectToolWithDiagnosticBlock();
    const finallyIndex = block.lastIndexOf("} finally {");
    const clearIndex = block.indexOf(
      'setTurnPhase((prev) => (prev === "acting" ? "thinking" : prev));',
      finallyIndex,
    );
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(finallyIndex);
  });

  it("execute_instruction (bypasses the shared wrapper) sets Acting at start and clears it in its own finally, even on error", () => {
    const start = SOURCE.indexOf("execute_instruction: async (params: ExecuteInstructionParams) => {");
    expect(start).toBeGreaterThan(-1);
    const setActingIndex = SOURCE.indexOf('setTurnPhase("acting");', start);
    const finallyIndex = SOURCE.indexOf("} finally {", start);
    const clearIndex = SOURCE.indexOf(
      'setTurnPhase((prev) => (prev === "acting" ? "thinking" : prev));',
      finallyIndex,
    );
    expect(setActingIndex).toBeGreaterThan(start);
    expect(finallyIndex).toBeGreaterThan(setActingIndex);
    expect(clearIndex).toBeGreaterThan(finallyIndex);
    expect(clearIndex).toBeLessThan(start + 3000); // stays within this one clientTools entry
  });

  it("create_automation (bypasses the shared wrapper) sets Acting and clears it via .finally() on the returned promise, even on error", () => {
    const start = SOURCE.indexOf("create_automation: (params: Parameters<typeof createAutomation>[0]) => {");
    expect(start).toBeGreaterThan(-1);
    const block = SOURCE.slice(start, start + 400);
    expect(block).toContain('setTurnPhase("acting");');
    expect(block).toMatch(
      /createAutomation\(params\)\.finally\(\(\) => \{\s*setTurnPhase\(\(prev\) => \(prev === "acting" \? "thinking" : prev\)\);/,
    );
  });
});

describe("ElevenLabsAgentWidget — speaking event changes UI to Speaking; new turn cannot inherit an old state", () => {
  function onModeChangeBlock(): string {
    const start = SOURCE.indexOf('onModeChange: ({ mode: m }) => {');
    const end = SOURCE.indexOf("onMessage: ({ role, message, event_id }) => {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("the rendered label prioritizes mode===\"speaking\" above turnPhase, so Speaking always wins once the SDK reports it", () => {
    expect(SOURCE).toMatch(
      /\{mode === "speaking"\s*\n\s*\? "Speaking…"\s*\n\s*: turnPhase === "acting"/,
    );
  });

  it("resets turnPhase to idle and clears the pending thinking timer whenever the SDK reports listening (a fresh turn boundary) — the next turn cannot inherit heard/thinking/acting from the previous one", () => {
    const block = onModeChangeBlock();
    const elseIndex = block.indexOf("} else {");
    expect(elseIndex).toBeGreaterThan(-1);
    const tail = block.slice(elseIndex);
    expect(tail).toContain("clearTurnPhaseThinkingTimeout();");
    expect(tail).toContain('setTurnPhase("idle");');
  });
});

describe("ElevenLabsAgentWidget — disconnect and error clear the processing state", () => {
  it("onDisconnect clears the thinking timer and resets turnPhase to idle", () => {
    const start = SOURCE.indexOf('onDisconnect: (details?: {');
    const end = SOURCE.indexOf("onError: (msg, context?: unknown) => {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain("clearTurnPhaseThinkingTimeout();");
    expect(block).toContain('setTurnPhase("idle");');
  });

  it("onError clears the thinking timer and resets turnPhase to idle", () => {
    const start = SOURCE.indexOf("onError: (msg, context?: unknown) => {");
    const end = SOURCE.indexOf("onConnect: () => {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain("clearTurnPhaseThinkingTimeout();");
    expect(block).toContain('setTurnPhase("idle");');
  });
});

describe("ElevenLabsAgentWidget — latency instrumentation covers tool-free turns without dropping the existing tool-turn trace", () => {
  // Bounded to the end of onModeChange (not the first "} else {", which is
  // the inner tool-free branch's own opening — that content must stay
  // INSIDE the extracted block, not be used as its end boundary).
  function onModeChangeSpeakingBlock(): string {
    const start = SOURCE.indexOf('if (m === "speaking") {');
    const end = SOURCE.indexOf("onMessage: ({ role, message, event_id }) => {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("preserves the existing tool-turn latency trace (tool_completion_to_first_response_ms) unchanged", () => {
    const block = onModeChangeSpeakingBlock();
    expect(block).toContain("active.trace.stages.tool_completion_to_first_response_ms = roundDuration(");
    expect(block).toContain('recordCarsonDiagnostic("carson-latency", active.trace);');
  });

  it("records a tool-free turn's latency via createToolFreeTurnLatencyTrace when no tool ran", () => {
    const block = onModeChangeSpeakingBlock();
    const elseIndex = block.indexOf("} else {");
    expect(elseIndex).toBeGreaterThan(-1);
    const tail = block.slice(elseIndex);
    expect(tail).toContain("createToolFreeTurnLatencyTrace({");
    expect(tail).toContain('recordCarsonDiagnostic("carson-latency", trace);');
  });

  it("dedupes tool-free latency logging per transcript eventId, and never logs transcript text — only ids, timestamps, and durations", () => {
    const block = onModeChangeSpeakingBlock();
    expect(block).toContain("turnLatencyLoggedForEventIdRef.current !== timing.eventId");
    expect(block).toContain("turnLatencyLoggedForEventIdRef.current = timing.eventId;");
    // The trace is built entirely from timing.eventId/receivedAt/receivedPerf
    // and performance.now() — never from `message`.
    expect(block).not.toMatch(/createToolFreeTurnLatencyTrace\(\{[^}]*message/);
  });

  it("imports createToolFreeTurnLatencyTrace from the shared latency lib", () => {
    expect(SOURCE).toContain("createToolFreeTurnLatencyTrace,");
    expect(SOURCE).toContain('from "../../lib/carson-latency";');
  });
});

describe("ElevenLabsAgentWidget — existing iPhone teardown and mute behavior is unchanged", () => {
  it("does not reintroduce app-level setMicMuted calls on mode transitions (the no-half-duplex-mute fix stays intact)", () => {
    expect(SOURCE).not.toMatch(/conversationRef\.current\?\.setMicMuted\(/);
  });

  it("still passes the same iOS connectionDelay mitigation to startSession", () => {
    expect(SOURCE).toMatch(/connectionDelay:\s*\{\s*default:\s*0,\s*android:\s*3_000,\s*ios:\s*500\s*\}/);
  });
});
