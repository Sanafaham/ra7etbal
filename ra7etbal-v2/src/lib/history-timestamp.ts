/**
 * Formats a completed task's display timestamp for What's Happening →
 * History cards. Field priority mirrors the existing History.tsx/
 * HistoryCard.tsx grouping fallback: confirmed_at -> archived_at ->
 * created_at. created_at is always present, so a done task always resolves
 * to a displayable timestamp.
 */
export function formatHistoryCompletedAt(
  confirmedAt: string | null,
  archivedAt: string | null,
  createdAt: string,
): string | null {
  const stamp = confirmedAt ?? archivedAt ?? createdAt;
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
