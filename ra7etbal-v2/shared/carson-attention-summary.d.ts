import type { MorningBriefData } from "./carson-morning-brief-classifier";
import type { UnresolvedCapture } from "./carson-unresolved-captures-classifier";

export interface AttentionItem {
  id: string;
  label: string;
  reason: string;
}

export interface AttentionSummaryEvidence {
  ok: boolean;
  code: "attention_read_succeeded" | "attention_read_partial" | "attention_auth_failed" | "attention_read_failed";
  generatedAt: string;
  completeness: "full" | "partial" | "none";
  needsAttention: AttentionItem[];
  waiting: AttentionItem[];
  carsonCanHandle: AttentionItem[];
  safeToIgnore: AttentionItem[];
  unresolvedCaptures: AttentionItem[];
  selectedCaptureIds?: Array<{ id: string; kind: "note" | "todo" }>;
}

export interface NeedsYouEscalationLike {
  id: string;
  staffName: string;
  escalationReason?: string | null;
}

export function composeAttentionEvidence(input: {
  generatedAt: string;
  brief: MorningBriefData | null;
  tasksFailed: boolean;
  needsYou: NeedsYouEscalationLike[] | null;
  needsYouFailed: boolean;
  captureCandidates: UnresolvedCapture[] | null;
  capturesFailed: boolean;
}): AttentionSummaryEvidence;

export function renderAttentionSummary(evidence: AttentionSummaryEvidence): string;
