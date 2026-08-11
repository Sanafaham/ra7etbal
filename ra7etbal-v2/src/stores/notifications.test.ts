import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerNotification } from "../types/notification";
import { useNotificationsStore, selectUnreadNotificationCount } from "./notifications";
import {
  listOwnerNotifications,
  markAllOwnerNotificationsRead,
  markOwnerNotificationRead,
} from "../lib/notifications";

vi.mock("../lib/notifications", () => ({
  listOwnerNotifications: vi.fn(),
  markAllOwnerNotificationsRead: vi.fn(),
  markOwnerNotificationRead: vi.fn(),
}));

const listMock = vi.mocked(listOwnerNotifications);
const markOneMock = vi.mocked(markOwnerNotificationRead);
const markAllMock = vi.mocked(markAllOwnerNotificationsRead);

beforeEach(() => {
  vi.clearAllMocks();
  useNotificationsStore.getState().reset();
});

describe("notifications inbox state", () => {
  it("loads a durable newest-first list and exposes the unread count", async () => {
    listMock.mockResolvedValue([notification("new"), notification("read", "2026-08-12T10:00:00Z")]);
    await useNotificationsStore.getState().loadFor("user-1");
    expect(useNotificationsStore.getState().items.map((item) => item.id)).toEqual(["new", "read"]);
    expect(selectUnreadNotificationCount(useNotificationsStore.getState())).toBe(1);
  });

  it("marks exactly one notification read", async () => {
    listMock.mockResolvedValue([notification("one"), notification("two")]);
    await useNotificationsStore.getState().loadFor("user-1");
    await useNotificationsStore.getState().markRead("one");
    expect(markOneMock).toHaveBeenCalledTimes(1);
    expect(useNotificationsStore.getState().items.find((item) => item.id === "one")?.read_at).not.toBeNull();
    expect(useNotificationsStore.getState().items.find((item) => item.id === "two")?.read_at).toBeNull();
  });

  it("marks all unread rows and survives a forced reload", async () => {
    listMock.mockResolvedValueOnce([notification("one"), notification("two")]);
    await useNotificationsStore.getState().loadFor("user-1");
    await useNotificationsStore.getState().markAllRead();
    expect(markAllMock).toHaveBeenCalledTimes(1);
    expect(selectUnreadNotificationCount(useNotificationsStore.getState())).toBe(0);

    listMock.mockResolvedValueOnce([
      notification("one", "2026-08-12T10:00:00Z"),
      notification("two", "2026-08-12T10:00:00Z"),
    ]);
    await useNotificationsStore.getState().loadFor("user-1", { force: true });
    expect(selectUnreadNotificationCount(useNotificationsStore.getState())).toBe(0);
  });
});

function notification(id: string, readAt: string | null = null): OwnerNotification {
  return {
    id, user_id: "user-1", event_key: `reminder_due:${id}`, kind: "reminder_due",
    title: "Ra7etBal", body: id, occurred_at: "2026-08-12T10:00:00Z", read_at: readAt,
    target_type: "task", target_id: id, target_url: "/updates?tab=todo", metadata: {},
    created_at: "2026-08-12T10:00:00Z",
  };
}
