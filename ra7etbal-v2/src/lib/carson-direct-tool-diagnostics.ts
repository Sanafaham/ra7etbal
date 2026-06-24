const INPUT_PREVIEW_LIMIT = 80;
const ERROR_PREVIEW_LIMIT = 120;

export interface CarsonDirectToolDiagnosticEvent {
  tool_name: string;
  timestamp: string;
  duration_ms: number;
  success: boolean;
  result_type: string;
  input_summary?: unknown;
  error_message?: string;
}

export function buildCarsonDirectToolDiagnosticEvent({
  toolName,
  startedAt,
  durationMs,
  success,
  result,
  input,
  error,
}: {
  toolName: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  result?: unknown;
  input?: unknown;
  error?: unknown;
}): CarsonDirectToolDiagnosticEvent {
  const event: CarsonDirectToolDiagnosticEvent = {
    tool_name: toolName,
    timestamp: startedAt,
    duration_ms: roundDuration(durationMs),
    success,
    result_type: getResultType(result),
  };

  const inputSummary = summarizeDiagnosticInput(input);
  if (inputSummary !== undefined) event.input_summary = inputSummary;

  if (!success) {
    event.error_message = previewError(error);
  }

  return event;
}

export function summarizeDiagnosticInput(input: unknown): unknown {
  if (input == null) return undefined;

  if (typeof input === "string") {
    return { value_preview: preview(input) };
  }

  if (typeof input === "number" || typeof input === "boolean") {
    return input;
  }

  if (Array.isArray(input)) {
    return {
      type: "array",
      count: input.length,
    };
  }

  if (typeof input !== "object") {
    return { type: typeof input };
  }

  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    summary[key] = summarizeInputValue(value);
  }
  return summary;
}

function summarizeInputValue(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") return preview(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (value instanceof Date) return value.toISOString();
  if (typeof File !== "undefined" && value instanceof File) {
    return { type: "file", name_preview: preview(value.name), size: value.size };
  }
  if (typeof value === "object") {
    return { type: "object", keys: Object.keys(value as Record<string, unknown>).slice(0, 8) };
  }
  return { type: typeof value };
}

function getResultType(result: unknown): string {
  if (result === undefined) return "undefined";
  if (result === null) return "null";
  if (Array.isArray(result)) return "array";
  return typeof result;
}

function previewError(error: unknown): string {
  if (error instanceof Error) return preview(error.message, ERROR_PREVIEW_LIMIT);
  if (typeof error === "string") return preview(error, ERROR_PREVIEW_LIMIT);
  return preview(String(error), ERROR_PREVIEW_LIMIT);
}

function preview(value: string, limit = INPUT_PREVIEW_LIMIT): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1)}…`;
}

function roundDuration(value: number): number {
  return Math.round(value * 10) / 10;
}
