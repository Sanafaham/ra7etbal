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

function onMessageUserBlock(): string {
  const start = SOURCE.indexOf("invalidCaptureRef.current = null;\n            sessionTranscriptRef.current.push");
  const end = SOURCE.indexOf("if (detectAllRecurringSchedules(message).length > 0)", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

function invalidCaptureBlock(): string {
  const start = SOURCE.indexOf("if (!captureEvaluation.valid) {");
  const end = SOURCE.indexOf("\n            }\n\n            invalidCaptureRef.current = null;", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — CarsonTurnPhase type and no microphone changes", () => {
  it("defines the truthful CarsonTurnPhase states", () => {
    expect(SOURCE).toContain(
      'type CarsonTurnPhase = "idle" | "heard" | "thinking" | "acting";',
    );
  });

  it("does not add or change microphone audio constraints in this phase — the three getUserMedia call sites stay unmodified", () => {
    expect(SOURCE).not.toMatch(/echoCancellation/);
    expect(SOURCE).not.toMatch(/noiseSuppression/);
    expect(SOURCE).not.toMatch(/autoGainControl/);
    // Every getUserMedia call in the file must still request the plain,
    // unmodified stream — this fails if any call site gains a constraints
    // object (not just if specific keyword identifiers appear), and would
    // also fail if the last known call site were removed.
    const calls = SOURCE.match(/getUserMedia\(([^)]*)\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toBe("getUserMedia({ audio: true })");
    }
    // sampleRate/channelCount as getUserMedia constraints — the diagnostic
    // packet's string label "sdk-default" is unrelated and must remain.
    expect(SOURCE).toContain('sampleRate: "sdk-default"');
  });
});

describe("ElevenLabsAgentWidget — final transcript changes UI to Heard you / Thinking", () => {
  it("sets turnPhase to heard immediately on a valid final transcript, with no delay before that", () => {
    const block = onMessageUserBlock();
    expect(block).toContain('setTurnPhase("heard");');
    // No delay before "heard" itself — the timer only exists to flip the
    // label onward to "thinking", not to gate showing "heard" at all.
    const heardIndex = block.indexOf('setTurnPhase("heard");');
    const timeoutIndex = block.indexOf("turnPhaseThinkingTimeoutRef.current = setTimeout(");
    expect(timeoutIndex).toBeGreaterThan(heardIndex);
  });

  it("flips heard -> thinking after exactly 600ms, never overwriting a phase that already moved on (acting/idle)", () => {
    const block = onMessageUserBlock();
    const timeoutIndex = block.indexOf("turnPhaseThinkingTimeoutRef.current = setTimeout(");
    expect(timeoutIndex).toBeGreaterThan(-1);
    const timeoutCallSite = block.slice(timeoutIndex, timeoutIndex + 300);
    expect(timeoutCallSite).toMatch(
      /setTurnPhase\(\(prev\) => \(prev === "heard" \? "thinking" : prev\)\);\s*\n\s*\}, 600\);/,
    );
  });

  it("resets turnLatencyLoggedForEventIdRef and toolRanForCurrentTranscriptRef for the new turn, before setting heard", () => {
    const block = onMessageUserBlock();
    const resetLatencyIndex = block.indexOf("turnLatencyLoggedForEventIdRef.current = null;");
    const resetToolRanIndex = block.indexOf("toolRanForCurrentTranscriptRef.current = false;");
    const heardIndex = block.indexOf('setTurnPhase("heard");');
    expect(resetLatencyIndex).toBeGreaterThan(-1);
    expect(resetToolRanIndex).toBeGreaterThan(-1);
    expect(resetToolRanIndex).toBeLessThan(heardIndex);
    expect(resetLatencyIndex).toBeLessThan(heardIndex);
  });

  // CodeRabbit finding: bound the assertion to the actual invalid-capture
  // if-block (via its closing brace), rather than just finding *some*
  // `return;` before `setTurnPhase("heard")` anywhere later in the file.
  it("does not set heard/thinking for an invalid (non-user) capture — the transition sits entirely after the invalid-capture block's own return", () => {
    const block = invalidCaptureBlock();
    expect(block).toContain("return;");
    expect(block).not.toContain('setTurnPhase("heard")');
  });

  // CodeRabbit finding: an invalid capture must clear stale transcript
  // timing and any pending thinking-timer from a prior valid transcript —
  // otherwise a later "speaking" event could compute latency against a
  // transcript that was never a genuine turn, or the timer could fire at
  // an unrelated moment.
  it("clears lastUserTranscriptTimingRef and the pending thinking timer on an invalid capture", () => {
    const block = invalidCaptureBlock();
    expect(block).toContain("lastUserTranscriptTimingRef.current = null;");
    expect(block).toContain("clearTurnPhaseThinkingTimeout();");
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

  it("sets Acting and marks toolRanForCurrentTranscriptRef before the tool runs, for every tool sharing this wrapper", () => {
    const block = runDirectToolWithDiagnosticBlock();
    const setActingIndex = block.indexOf('setTurnPhase("acting");');
    const markToolRanIndex = block.indexOf("toolRanForCurrentTranscriptRef.current = true;");
    const tryIndex = block.indexOf("try {", setActingIndex);
    expect(setActingIndex).toBeGreaterThan(-1);
    expect(markToolRanIndex).toBeGreaterThan(setActingIndex);
    expect(tryIndex).toBeGreaterThan(markToolRanIndex);
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

  it("execute_instruction (bypasses the shared wrapper) sets Acting + toolRan at start and clears Acting in its own finally, even on error", () => {
    const start = SOURCE.indexOf("execute_instruction: async (params: ExecuteInstructionParams) => {");
    expect(start).toBeGreaterThan(-1);
    const setActingIndex = SOURCE.indexOf('setTurnPhase("acting");', start);
    const markToolRanIndex = SOURCE.indexOf("toolRanForCurrentTranscriptRef.current = true;", start);
    const finallyIndex = SOURCE.indexOf("} finally {", start);
    const clearIndex = SOURCE.indexOf(
      'setTurnPhase((prev) => (prev === "acting" ? "thinking" : prev));',
      finallyIndex,
    );
    expect(setActingIndex).toBeGreaterThan(start);
    expect(markToolRanIndex).toBeGreaterThan(setActingIndex);
    expect(finallyIndex).toBeGreaterThan(markToolRanIndex);
    expect(clearIndex).toBeGreaterThan(finallyIndex);
    expect(clearIndex).toBeLessThan(start + 3000); // stays within this one clientTools entry
  });

  // CodeRabbit finding: verify the handler actually returns the promise
  // chain from createAutomation(...).finally(...), not merely that
  // ".finally(" appears somewhere nearby.
  it("create_automation (bypasses the shared wrapper) returns createAutomation(params).finally(...), marking Acting/toolRan first and clearing Acting even on error", () => {
    const start = SOURCE.indexOf("create_automation: (params: Parameters<typeof createAutomation>[0]) => {");
    expect(start).toBeGreaterThan(-1);
    const block = SOURCE.slice(start, start + 600);
    const setActingIndex = block.indexOf('setTurnPhase("acting");');
    const markToolRanIndex = block.indexOf("toolRanForCurrentTranscriptRef.current = true;");
    const returnIndex = block.indexOf("return createAutomation(params).finally(() => {");
    expect(setActingIndex).toBeGreaterThan(-1);
    expect(markToolRanIndex).toBeGreaterThan(setActingIndex);
    expect(returnIndex).toBeGreaterThan(markToolRanIndex);
    expect(block).toMatch(
      /return createAutomation\(params\)\.finally\(\(\) => \{\s*setTurnPhase\(\(prev\) => \(prev === "acting" \? "thinking" : prev\)\);/,
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

  it("the rendered label maps every turnPhase to its own text, with mode===\"speaking\" taking priority above all of them", () => {
    expect(SOURCE).toMatch(
      /\{mode === "speaking"\s*\n\s*\? "Speaking…"\s*\n\s*: turnPhase === "acting"\s*\n\s*\? "Acting…"\s*\n\s*: turnPhase === "thinking"\s*\n\s*\? "Thinking…"\s*\n\s*: turnPhase === "heard"\s*\n\s*\? "Heard you"\s*\n\s*: "Listening…"\}/,
    );
  });

  it("resets turnPhase to idle and clears the pending thinking timer whenever the SDK reports listening (a fresh turn boundary) — the next turn cannot inherit heard/thinking/acting from the previous one", () => {
    const block = onModeChangeBlock();
    const elseIndex = block.lastIndexOf("} else {");
    expect(elseIndex).toBeGreaterThan(-1);
    const tail = block.slice(elseIndex);
    expect(tail).toContain("clearTurnPhaseThinkingTimeout();");
    expect(tail).toContain('setTurnPhase("idle");');
  });
});

describe("ElevenLabsAgentWidget — disconnect, error, and forced cleanup all clear the processing state", () => {
  it("onDisconnect clears the thinking timer, resets turnPhase to idle, and clears the latency refs so a later session cannot inherit stale timing", () => {
    const start = SOURCE.indexOf('onDisconnect: (details?: {');
    const end = SOURCE.indexOf("onError: (msg, context?: unknown) => {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain("clearTurnPhaseThinkingTimeout();");
    expect(block).toContain('setTurnPhase("idle");');
    // CodeRabbit finding: onDisconnect reset only the visual phase, leaving
    // activeExecuteLatencyRef/lastUserTranscriptTimingRef/
    // turnLatencyLoggedForEventIdRef populated with this session's data —
    // a later session's first "speaking" event could log or complete a
    // trace against stale timing.
    expect(block).toContain("activeExecuteLatencyRef.current = null;");
    expect(block).toContain("lastUserTranscriptTimingRef.current = null;");
    expect(block).toContain("turnLatencyLoggedForEventIdRef.current = null;");
    expect(block).toContain("toolRanForCurrentTranscriptRef.current = false;");
  });

  it("onError clears the thinking timer, resets turnPhase to idle, and clears the latency refs so a later session cannot inherit stale timing", () => {
    const start = SOURCE.indexOf("onError: (msg, context?: unknown) => {");
    const end = SOURCE.indexOf("onConnect: () => {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain("clearTurnPhaseThinkingTimeout();");
    expect(block).toContain('setTurnPhase("idle");');
    expect(block).toContain("activeExecuteLatencyRef.current = null;");
    expect(block).toContain("lastUserTranscriptTimingRef.current = null;");
    expect(block).toContain("turnLatencyLoggedForEventIdRef.current = null;");
    expect(block).toContain("toolRanForCurrentTranscriptRef.current = false;");
  });

  // CodeRabbit finding: forceCleanupSession (manual end, pagehide,
  // connection-timeout) is a THIRD teardown path, separate from
  // onDisconnect/onError, that was initially missed.
  it("forceCleanupSession clears the thinking timer, resets turnPhase to idle, and resets the latency-dedup and tool-ran refs", () => {
    const start = SOURCE.indexOf("const forceCleanupSession = useCallback(");
    const end = SOURCE.indexOf("if (conv) {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain("clearTurnPhaseThinkingTimeout();");
    expect(block).toContain('setTurnPhase("idle");');
    expect(block).toContain("turnLatencyLoggedForEventIdRef.current = null;");
    expect(block).toContain("toolRanForCurrentTranscriptRef.current = false;");
  });
});

describe("ElevenLabsAgentWidget — latency instrumentation covers tool-free turns without dropping the existing tool-turn trace", () => {
  // Bounded to the end of onModeChange (not the first "} else {" inside it,
  // which is the tool-free branch's own opening — that content must stay
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

  // CodeRabbit finding (real bug): activeExecuteLatencyRef only reflects
  // execute_instruction — a turn where any OTHER tool ran (create_reminder,
  // create_todo, etc.) must NOT be treated as tool-free. The gate is now
  // `!toolRanForCurrentTranscriptRef.current`, not merely "the
  // execute_instruction-specific trace is absent."
  it("only logs tool-free latency when toolRanForCurrentTranscriptRef confirms no tool ran at all this transcript — not merely that execute_instruction's own trace is absent", () => {
    const block = onModeChangeSpeakingBlock();
    expect(block).toContain("} else if (!toolRanForCurrentTranscriptRef.current) {");
  });

  it("records a tool-free turn's latency via createToolFreeTurnLatencyTrace when no tool ran", () => {
    const block = onModeChangeSpeakingBlock();
    const elseIfIndex = block.indexOf("} else if (!toolRanForCurrentTranscriptRef.current) {");
    expect(elseIfIndex).toBeGreaterThan(-1);
    const tail = block.slice(elseIfIndex);
    expect(tail).toContain("createToolFreeTurnLatencyTrace({");
    expect(tail).toContain('recordCarsonDiagnostic("carson-latency", trace);');
  });

  it("dedupes tool-free latency logging per transcript eventId inside the guard, and never logs transcript text — only ids, timestamps, and durations", () => {
    const block = onModeChangeSpeakingBlock();
    const elseIfIndex = block.indexOf("} else if (!toolRanForCurrentTranscriptRef.current) {");
    const tail = block.slice(elseIfIndex);
    const guardIndex = tail.indexOf(
      "timing?.eventId != null &&\n                turnLatencyLoggedForEventIdRef.current !== timing.eventId",
    );
    const traceCallIndex = tail.indexOf("createToolFreeTurnLatencyTrace({", guardIndex);
    const markLoggedIndex = tail.indexOf("turnLatencyLoggedForEventIdRef.current = timing.eventId;", traceCallIndex);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(traceCallIndex).toBeGreaterThan(guardIndex);
    expect(markLoggedIndex).toBeGreaterThan(traceCallIndex);
    // The trace payload is built entirely from timing.eventId/receivedAt/
    // receivedPerf and performance.now() — extract just the call arguments
    // and confirm no `message` field is threaded through, including via a
    // spread.
    const traceCallArgs = tail.slice(traceCallIndex, tail.indexOf("});", traceCallIndex) + 3);
    expect(traceCallArgs).not.toMatch(/message/);
    expect(traceCallArgs).not.toMatch(/\.\.\./);
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
