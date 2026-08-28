export interface RiskItem {
  task: unknown;
  reason: string;
}

export interface MorningBriefData<TTask = unknown> {
  needsAttention: TTask[];
  waitingOn: TTask[];
  overdueItems: TTask[];
  recentCompletions: TTask[];
  risks: RiskItem[];
}

export function isReminderOverdue(value: string | null, now?: Date): boolean;

export function formatReminderDue(value: string | null, now?: Date): string | null;

export function isSameLocalDay(a: Date, b: Date): boolean;

export function getDateValue(value: string | null): number;

export function buildRisks(waitingOn: unknown[], nowMs: number): RiskItem[];

export function buildMorningBrief<TTask = unknown, TPerson = unknown>(
  tasks: TTask[],
  people: TPerson[],
  now?: Date,
  routineAutomationTaskIds?: Set<string>,
): MorningBriefData<TTask>;

export function taskLabel(raw: string, assigneeName?: string | null): string;
