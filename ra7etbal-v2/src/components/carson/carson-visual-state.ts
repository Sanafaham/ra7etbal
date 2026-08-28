export type CarsonVisualState =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "speaking"
  | "complete"
  | "error";

export type CarsonVisualOutcome = "none" | "complete" | "error";

export interface CarsonVisualSignals {
  status: "idle" | "connecting" | "connected" | "error";
  channel: "voice" | "text";
  mode: "listening" | "speaking";
  turnPhase: "idle" | "heard" | "thinking" | "acting";
  outcome: CarsonVisualOutcome;
}

export function deriveCarsonVisualState({
  status,
  channel,
  mode,
  turnPhase,
  outcome,
}: CarsonVisualSignals): CarsonVisualState {
  if (status === "error" || outcome === "error") return "error";
  if (status !== "connected" || channel !== "voice") return "idle";
  if (mode === "speaking") return "speaking";
  if (turnPhase === "acting") return "working";
  if (outcome === "complete") return "complete";
  if (turnPhase === "heard" || turnPhase === "thinking") return "thinking";
  return "listening";
}

export const CARSON_VISUAL_LABELS: Record<CarsonVisualState, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  working: "Working",
  speaking: "Speaking",
  complete: "Handled",
  error: "Cannot confirm",
};
