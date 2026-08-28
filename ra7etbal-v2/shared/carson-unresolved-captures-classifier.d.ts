export interface UnresolvedCapture {
  id: string;
  kind: "note" | "todo";
  text: string;
  ageDays: number;
  neverSurfaced: boolean;
  actionable: boolean;
}

export interface CaptureNoteLike {
  id: string;
  note: string;
  created_at: string;
  last_surfaced_at?: string | null;
}

export interface CaptureTodoLike {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  last_surfaced_at?: string | null;
}

export function isActionLedText(text: string): boolean;

export function ageInDays(createdAt: string, now: Date): number;

export function noteToCapture(note: CaptureNoteLike, now: Date): UnresolvedCapture;

export function todoToCapture(todo: CaptureTodoLike, now: Date): UnresolvedCapture;

export function classifyAttentionWorthyCaptures(
  candidates: UnresolvedCapture[],
  maxItems?: number,
): UnresolvedCapture[];
