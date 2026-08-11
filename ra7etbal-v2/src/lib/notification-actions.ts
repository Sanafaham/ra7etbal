import type { OwnerNotification } from "../types/notification";

export async function openOwnerNotification(
  item: OwnerNotification,
  actions: { markRead: (id: string) => Promise<void>; navigate: (url: string) => void },
): Promise<void> {
  await actions.markRead(item.id);
  if (isSafeNotificationRoute(item.target_url)) actions.navigate(item.target_url!);
}

export async function markEveryOwnerNotificationRead(
  markAllRead: () => Promise<void>,
): Promise<void> {
  await markAllRead();
}

export function isSafeNotificationRoute(value: string | null): boolean {
  return Boolean(value && /^\/(notifications|updates|history|people)(?:$|[/?#])/.test(value));
}
