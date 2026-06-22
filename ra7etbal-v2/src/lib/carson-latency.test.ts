import { describe, expect, it, vi } from "vitest";
import {
  addLatencyStageDuration,
  createExecuteInstructionLatencyTrace,
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
