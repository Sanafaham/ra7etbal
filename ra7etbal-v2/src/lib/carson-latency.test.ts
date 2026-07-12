import { describe, expect, it, vi } from "vitest";
import {
  addLatencyStageDuration,
  createExecuteInstructionLatencyTrace,
  createToolFreeTurnLatencyTrace,
  roundDuration,
} from "./carson-latency";

describe("Carson execute_instruction latency tracing", () => {
  it("calculates transcript-to-tool latency and initializes all requested stages", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "trace-1" });

    const trace = createExecuteInstructionLatencyTrace({
      transcriptEventId: 42,
      transcriptReceivedAt: "2026-06-23T10:00:00.000Z",
      transcriptReceivedPerf: 100,
      toolStartedAt: "2026-06-23T10:00:00.125Z",
      toolStartedPerf: 225.46,
    });

    expect(trace).toEqual({
      trace_id: "trace-1",
      transcript_event_id: 42,
      transcript_received_at: "2026-06-23T10:00:00.000Z",
      tool_started_at: "2026-06-23T10:00:00.125Z",
      tool_completed_at: null,
      first_response_at: null,
      outcome: "pending",
      stages: {
        transcript_to_tool_start_ms: 125.5,
        execute_instruction_ms: null,
        claude_extraction_ms: 0,
        supabase_operations_ms: 0,
        whatsapp_send_flow_ms: 0,
        tool_completion_to_first_response_ms: null,
      },
    });

    vi.unstubAllGlobals();
  });

  it("aggregates repeated Supabase operations without losing precision", () => {
    const trace = createExecuteInstructionLatencyTrace({
      transcriptEventId: null,
      transcriptReceivedAt: null,
      transcriptReceivedPerf: null,
      toolStartedAt: "2026-06-23T10:00:00.000Z",
      toolStartedPerf: 0,
    });

    addLatencyStageDuration(trace, "supabase_operations_ms", 10.04);
    addLatencyStageDuration(trace, "supabase_operations_ms", 20.08);
    addLatencyStageDuration(trace, "claude_extraction_ms", 300.26);

    expect(trace.stages.supabase_operations_ms).toBe(30.1);
    expect(trace.stages.claude_extraction_ms).toBe(300.3);
    expect(roundDuration(-2)).toBe(0);
  });
});

// Phase 1 of the Carson voice reliability work: latency visibility for
// turns where no client tool was invoked (a direct conversational reply) —
// previously only tool-invoking turns via createExecuteInstructionLatencyTrace
// had any latency trace at all.
describe("Carson tool-free turn latency tracing", () => {
  it("computes transcript_to_speaking_ms from the two perf timestamps only", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "trace-2" });

    const trace = createToolFreeTurnLatencyTrace({
      transcriptEventId: 42,
      transcriptReceivedAt: "2026-07-12T05:00:00.000Z",
      transcriptReceivedPerf: 1000,
      respondedPerf: 1842.4,
    });

    expect(trace).toEqual({
      trace_id: "trace-2",
      kind: "tool_free_turn",
      transcript_event_id: 42,
      transcript_received_at: "2026-07-12T05:00:00.000Z",
      first_response_at: trace.first_response_at,
      stages: {
        transcript_to_speaking_ms: 842.4,
      },
    });

    vi.unstubAllGlobals();
  });

  it("never receives or stores transcript text — only ids, timestamps, and a duration", () => {
    const trace = createToolFreeTurnLatencyTrace({
      transcriptEventId: null,
      transcriptReceivedAt: null,
      transcriptReceivedPerf: 0,
      respondedPerf: 5,
    });

    expect(Object.keys(trace)).toEqual([
      "trace_id",
      "kind",
      "transcript_event_id",
      "transcript_received_at",
      "first_response_at",
      "stages",
    ]);
    expect(JSON.stringify(trace)).not.toMatch(/message|transcript_text|content/);
  });

  it("never produces a negative duration (roundDuration floors at 0)", () => {
    const trace = createToolFreeTurnLatencyTrace({
      transcriptEventId: 1,
      transcriptReceivedAt: null,
      transcriptReceivedPerf: 1000,
      respondedPerf: 500, // clock skew / out-of-order perf reads
    });
    expect(trace.stages.transcript_to_speaking_ms).toBe(0);
  });
});
