import type { UnresolvedCapture } from "./carson-unresolved-captures-classifier";
import type { RecurringSourceIndexes } from "./carson-recurring-manifestations";

export type AttentionCategory =
  | "needsYou"
  | "overdueReminders"
  | "upcomingReminders"
  | "waiting"
  | "later"
  | "unresolvedCaptures";

export interface AttentionItem {
  id: string;
  label: string;
  type: string;
  status: string;
  dueAt: string | null;
  dueDescription: string | null;
  assignee: string | null;
  category: AttentionCategory;
}

export interface AttentionSummaryEvidence {
  ok: boolean;
  code: "attention_read_succeeded" | "attention_read_partial" | "attention_auth_failed" | "attention_read_failed";
  generatedAt: string;
  completeness: "full" | "partial" | "none";
  needsYou: AttentionItem[];
  overdueReminders: AttentionItem[];
  upcomingReminders: AttentionItem[];
  waiting: AttentionItem[];
  later: AttentionItem[];
  unresolvedCaptures: AttentionItem[];
  selectedCaptureIds?: Array<{ id: string; kind: "note" | "todo" }>;
}

export interface NeedsYouEscalationLike {
  id: string;
  staffName: string;
  escalationReason?: string | null;
}

interface TaskLike {
  id: string;
  description: string;
  type: string;
  assigned_to: string | null;
  status: string;
  due_at: string | null;
  archived_at: string | null;
  needs_follow_up: boolean;
  quality_review_status: string | null | undefined;
  /** Read by the P3 5b recurring-manifestation derivation. */
  user_id?: string | null;
  created_at?: string | null;
  dismissed_at?: string | null;
}

export function composeAttentionEvidence(input: {
  generatedAt: string;
  now: Date;
  tasks: TaskLike[] | null;
  tasksFailed: boolean;
  needsYou: NeedsYouEscalationLike[] | null;
  needsYouFailed: boolean;
  captureCandidates: UnresolvedCapture[] | null;
  capturesFailed: boolean;
  routineAutomationTaskIds?: Set<string>;
  /**
   * Recurring-source link evidence (P3 5b). Omitting it resolves no source, so
   * nothing is superseded and composition behaves exactly as before.
   */
  recurringSourceIndexes?: RecurringSourceIndexes;
  /**
   * True when the recurring-source link read failed or timed out, so the
   * membership is the pre-correction one and completeness must report "partial".
   */
  recurringSourceFailed?: boolean;
}): AttentionSummaryEvidence;

export function renderAttentionSummary(evidence: AttentionSummaryEvidence): string;

export type AttentionResponseIntent =
  | "list"
  | "rank"
  | "contrast"
  | "explain"
  | "defer_timing"
  | "nothing_new"
  | "clarify"
  | "not_attention";

export interface AttentionDecision {
  responseIntent: AttentionResponseIntent;
  selectedEvidenceIds: string[];
  rankedEvidenceIds?: string[];
  contrastedEvidenceIds?: string[];
  needsClarification?: string | null;
}

export function renderAttentionDecision(evidence: AttentionSummaryEvidence, decision: AttentionDecision): string;
