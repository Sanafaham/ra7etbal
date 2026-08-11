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

  it("ignores a stale load when the authenticated account changes", async () => {
    const firstAccountLoad = deferred<OwnerNotification[]>();
    listMock
      .mockReturnValueOnce(firstAccountLoad.promise)
      .mockResolvedValueOnce([notification("second-account", null, "user-2")]);

    const staleLoad = useNotificationsStore.getState().loadFor("user-1");
    await useNotificationsStore.getState().loadFor("user-2");
    firstAccountLoad.resolve([notification("first-account")]);
    await staleLoad;

    expect(useNotificationsStore.getState().loadedForUserId).toBe("user-2");
    expect(useNotificationsStore.getState().items.map((item) => item.id)).toEqual(["second-account"]);
  });

  it("does not apply a stale mark-one result after reset and account switch", async () => {
    const pendingMark = deferred<void>();
    listMock.mockResolvedValueOnce([notification("shared-id")]);
    markOneMock.mockReturnValueOnce(pendingMark.promise);
    await useNotificationsStore.getState().loadFor("user-1");
    const staleMark = useNotificationsStore.getState().markRead("shared-id");

    useNotificationsStore.getState().reset();
    listMock.mockResolvedValueOnce([notification("shared-id", null, "user-2")]);
    await useNotificationsStore.getState().loadFor("user-2");
    pendingMark.resolve();
    await staleMark;

    expect(useNotificationsStore.getState().items[0]?.user_id).toBe("user-2");
    expect(useNotificationsStore.getState().items[0]?.read_at).toBeNull();
  });

  it("does not apply a stale mark-all result after reset and account switch", async () => {
    const pendingMarkAll = deferred<void>();
    listMock.mockResolvedValueOnce([notification("first-account")]);
    markAllMock.mockReturnValueOnce(pendingMarkAll.promise);
    await useNotificationsStore.getState().loadFor("user-1");
    const staleMark = useNotificationsStore.getState().markAllRead();

    useNotificationsStore.getState().reset();
    listMock.mockResolvedValueOnce([notification("second-account", null, "user-2")]);
    await useNotificationsStore.getState().loadFor("user-2");
    pendingMarkAll.resolve();
    await staleMark;

    expect(useNotificationsStore.getState().items[0]?.user_id).toBe("user-2");
    expect(useNotificationsStore.getState().items[0]?.read_at).toBeNull();
  });
});

function notification(id: string, readAt: string | null = null, userId = "user-1"): OwnerNotification {
  return {
    id, user_id: userId, event_key: `reminder_due:${id}`, kind: "reminder_due",
    title: "Ra7etBal", body: id, occurred_at: "2026-08-12T10:00:00Z", read_at: readAt,
    target_type: "task", target_id: id, target_url: "/updates?tab=todo", metadata: {},
    created_at: "2026-08-12T10:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
