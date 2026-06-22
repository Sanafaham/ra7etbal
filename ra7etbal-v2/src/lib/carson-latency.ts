export interface ExecuteInstructionLatencyStages {
  transcript_to_tool_start_ms: number | null;
  execute_instruction_ms: number | null;
  claude_extraction_ms: number;
  supabase_operations_ms: number;
  whatsapp_send_flow_ms: number;
  tool_completion_to_first_response_ms: number | null;
}

export interface ExecuteInstructionLatencyTrace {
  trace_id: string;
  transcript_event_id: number | null;
  transcript_received_at: string | null;
  tool_started_at: string;
  tool_completed_at: string | null;
  first_response_at: string | null;
  outcome: "pending" | "success" | "error";
  stages: ExecuteInstructionLatencyStages;
}

export function createExecuteInstructionLatencyTrace({
  transcriptEventId,
  transcriptReceivedAt,
  transcriptReceivedPerf,
  toolStartedAt,
  toolStartedPerf,
}: {
  transcriptEventId: number | null;
  transcriptReceivedAt: string | null;
  transcriptReceivedPerf: number | null;
  toolStartedAt: string;
  toolStartedPerf: number;
}): ExecuteInstructionLatencyTrace {
  return {
    trace_id: crypto.randomUUID(),
    transcript_event_id: transcriptEventId,
    transcript_received_at: transcriptReceivedAt,
    tool_started_at: toolStartedAt,
    tool_completed_at: null,
    first_response_at: null,
    outcome: "pending",
    stages: {
      transcript_to_tool_start_ms:
        transcriptReceivedPerf == null
          ? null
          : roundDuration(toolStartedPerf - transcriptReceivedPerf),
      execute_instruction_ms: null,
      claude_extraction_ms: 0,
      supabase_operations_ms: 0,
      whatsapp_send_flow_ms: 0,
      tool_completion_to_first_response_ms: null,
    },
  };
}

export function addLatencyStageDuration(
  trace: ExecuteInstructionLatencyTrace,
  stage:
    | "claude_extraction_ms"
    | "supabase_operations_ms"
    | "whatsapp_send_flow_ms",
  durationMs: number,
): void {
  trace.stages[stage] = roundDuration(trace.stages[stage] + durationMs);
}

export function roundDuration(durationMs: number): number {
  return Math.max(0, Math.round(durationMs * 10) / 10);
}

