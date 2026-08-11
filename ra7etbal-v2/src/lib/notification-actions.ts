import type { OwnerNotification } from "../types/notification";

export async function openOwnerNotification(
  item: OwnerNotification,
  actions: { markRead: (id: string) => Promise<void>; navigate: (url: string) => void },
): Promise<void> {
  await actions.markRead(item.id);
  const route = getOwnerNotificationRoute(item);
  if (route) actions.navigate(route);
}

export function getOwnerNotificationRoute(item: OwnerNotification): string | null {
  if (item.kind === "reminder_due" && item.target_type === "task" && item.target_id) {
    return `/updates?tab=needs-you&task=${encodeURIComponent(item.target_id)}`;
  }
  return isSafeNotificationRoute(item.target_url) ? item.target_url : null;
}

export async function markEveryOwnerNotificationRead(
  markAllRead: () => Promise<void>,
): Promise<void> {
  await markAllRead();
}

export function isSafeNotificationRoute(value: string | null): boolean {
  return Boolean(value && /^\/(notifications|updates|history|people)(?:$|[/?#])/.test(value));
}
