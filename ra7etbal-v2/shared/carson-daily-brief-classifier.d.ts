export interface DailyBriefTaskLike {
  id: string;
  status: string;
  type: string;
  assigned_to: string | null;
  needs_follow_up: boolean;
  quality_review_status: string | null | undefined;
  archived_at: string | null;
}

export function isNeedsYouTask(task: DailyBriefTaskLike, waitingIds: Set<string>): boolean;

export function isWaitingTask(task: DailyBriefTaskLike): boolean;

export function isLaterTask(task: DailyBriefTaskLike, needsYouIds: Set<string>, waitingIds: Set<string>): boolean;

export function buildDailyBriefBuckets<TTask extends DailyBriefTaskLike = DailyBriefTaskLike>(
  tasks: TTask[],
  now?: Date,
): { needsYou: TTask[]; waitingOnOthers: TTask[]; later: TTask[] };
