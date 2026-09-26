export const RESOLUTION_UNRESOLVED: "unresolved";
export const RESOLUTION_AMBIGUOUS: "ambiguous";
export const RESOLUTION_RESOLVED: "resolved";

export type RecurringResolution = "unresolved" | "ambiguous" | "resolved";

/** `automation_runs` row fields this module reads. Any `current_state` is accepted. */
export interface AutomationRunSourceRow {
  task_id?: string | null;
  automation_id?: string | null;
  user_id?: string | null;
}

/** `owner_notifications` row fields this module reads. */
export interface OwnerNotificationSourceRow {
  target_id?: string | null;
  kind?: string | null;
  user_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** The task fields this module reads. Structural, so both `Task` and raw rows fit. */
export interface RecurringManifestationTask {
  id?: string | null;
  user_id?: string | null;
  status?: string | null;
  created_at?: string | null;
  archived_at?: string | null;
  dismissed_at?: string | null;
}

export interface AutomationSourceLink {
  automationId: string | null;
  userId: string | null;
  conflict: boolean;
}

export interface RoutineSourceLink {
  routineId: string | null;
  userId: string | null;
  conflict: boolean;
}

export interface RecurringSourceIndexes {
  automationLinks?: Map<string, AutomationSourceLink> | null;
  routineLinks?: Map<string, RoutineSourceLink> | null;
  notificationAutomationClaims?: Map<string, Set<string>> | null;
}

export interface RecurringManifestationEntry {
  sourceKey: string | null;
  resolution: RecurringResolution;
  isCurrent: boolean;
}

export function indexAutomationSourceLinks(
  runRows: AutomationRunSourceRow[] | null | undefined,
): Map<string, AutomationSourceLink>;

export function indexRoutineSourceLinks(
  notificationRows: OwnerNotificationSourceRow[] | null | undefined,
): Map<string, RoutineSourceLink>;

export function indexNotificationAutomationClaims(
  notificationRows: OwnerNotificationSourceRow[] | null | undefined,
): Map<string, Set<string>>;

export function resolveRecurringSource(
  task: RecurringManifestationTask | null | undefined,
  indexes: RecurringSourceIndexes | null | undefined,
): { sourceKey: string | null; resolution: RecurringResolution };

export function deriveRecurringManifestationState<T extends RecurringManifestationTask>(
  tasks: T[] | null | undefined,
  indexes: RecurringSourceIndexes | null | undefined,
): Map<string, RecurringManifestationEntry>;

export function collectSupersededManifestationIds<T extends RecurringManifestationTask>(
  tasks: T[] | null | undefined,
  indexes: RecurringSourceIndexes | null | undefined,
): Set<string>;

export function withoutSupersededManifestations<T extends RecurringManifestationTask>(
  tasks: T[] | null | undefined,
  supersededIds: Set<string> | null | undefined,
): T[];
