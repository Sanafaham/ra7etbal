export type OwnerPerspectiveVoice = "owner_to_recipient" | "task_text" | "task_record" | "composed";

/** Perspective status declared by the existing model call that composed the text. */
export type DeclaredOwnerPerspective = "rendered" | "unclear";

export interface OwnerPerspectiveOptions {
  ownerName?: string | null;
  recipientName?: string | null;
  voice: OwnerPerspectiveVoice;
  declared?: DeclaredOwnerPerspective | null;
  /** Composed voice only: the owner's original words; the composed text must keep their language. */
  sourceText?: string | null;
  /** owner_to_recipient: false when he/him/her can never mean the recipient (staff answers: the person is named in the staff member's question). Default true. */
  thirdPersonMayMeanRecipient?: boolean;
  /** owner_to_recipient: the owner's verbatim current instruction. he/him/her becomes "you" only when it is exactly "Tell/Text/Message/Ask <recipient> [that] <this message>"; otherwise it fails closed. */
  currentInstruction?: string | null;
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
  detail: string;
  constructor(reason: string | null, recipientName?: string | null, detail?: string | null);
}

export function ownerPerspectiveDetail(): string;
export function ownerPerspectiveClarification(recipientName?: string | null): string;
export function isOwnerPerspectiveError(error: unknown): error is OwnerPerspectiveError;
export function resolveOwnerPerspective(text: string, options: OwnerPerspectiveOptions): OwnerPerspectiveResult;
export function renderOwnerPerspective(text: string, options: OwnerPerspectiveOptions): string;
export function withOwnerNameWhenNeeded<T>(
  build: (ownerName: string | null) => T,
  loadOwnerName: () => Promise<string | null | undefined> | string | null | undefined,
): Promise<{ text: T; ownerName: string | null }>;
