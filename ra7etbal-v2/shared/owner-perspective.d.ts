export type OwnerPerspectiveVoice = "owner_to_recipient" | "task_text" | "task_record";

export interface OwnerPerspectiveOptions {
  ownerName?: string | null;
  recipientName?: string | null;
  voice: OwnerPerspectiveVoice;
}

export interface OwnerPerspectiveResult {
  status: "unchanged" | "rendered" | "needs_composition";
  text: string;
  reason: string | null;
  language: string[];
}

export const OWNER_PERSPECTIVE_UNRESOLVED: "owner_perspective_unresolved";

export class OwnerPerspectiveError extends Error {
  code: typeof OWNER_PERSPECTIVE_UNRESOLVED;
  reason: string | null;
  constructor(reason: string | null, recipientName?: string | null);
}

export function ownerPerspectiveDetail(): string;
export function ownerPerspectiveClarification(recipientName?: string | null): string;
export function isOwnerPerspectiveError(error: unknown): error is OwnerPerspectiveError;
export function resolveOwnerPerspective(text: string, options: OwnerPerspectiveOptions): OwnerPerspectiveResult;
export function renderOwnerPerspective(text: string, options: OwnerPerspectiveOptions): string;
