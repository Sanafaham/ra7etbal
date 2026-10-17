import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerNotification } from "../types/notification";
import { useNotificationsStore, selectUnreadNotificationCount } from "./notifications";
import {
  listOwnerNotifications,
  markAllOwnerNotificationsRead,
  markOwnerNotificationRead,
  dismissOwnerNotification,
} from "../lib/notifications";

vi.mock("../lib/notifications", () => ({
  listOwnerNotifications: vi.fn(),
  markAllOwnerNotificationsRead: vi.fn(),
  markOwnerNotificationRead: vi.fn(),
  dismissOwnerNotification: vi.fn(),
}));

const listMock = vi.mocked(listOwnerNotifications);
const markOneMock = vi.mocked(markOwnerNotificationRead);
const markAllMock = vi.mocked(markAllOwnerNotificationsRead);
const dismissMock = vi.mocked(dismissOwnerNotification);

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

  it("dismisses one row immediately and it stays absent after a forced reload", async () => {
    listMock.mockResolvedValueOnce([notification("one"), notification("two")]);
    await useNotificationsStore.getState().loadFor("user-1");
    await useNotificationsStore.getState().dismiss("one");
    expect(dismissMock).toHaveBeenCalledWith("one", expect.any(String));
    expect(useNotificationsStore.getState().items.map((item) => item.id)).toEqual(["two"]);

    listMock.mockResolvedValueOnce([notification("two")]);
    await useNotificationsStore.getState().loadFor("user-1", { force: true });
    expect(useNotificationsStore.getState().items.map((item) => item.id)).toEqual(["two"]);
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
    title: "Ra7etBal", body: id, occurred_at: "2026-08-12T10:00:00Z", read_at: readAt, dismissed_at: null,
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

describe("notifications freshness without a push (PR #458 escalation incident)", () => {
  it("an unforced load keeps the stale list; a forced reload surfaces the new escalation", async () => {
    listMock.mockResolvedValueOnce([notification("old-reminder")]);
    await useNotificationsStore.getState().loadFor("user-1");

    listMock.mockResolvedValueOnce([
      notification("salmon-escalation"),
      notification("old-reminder"),
    ]);
    await useNotificationsStore.getState().loadFor("user-1");
    expect(useNotificationsStore.getState().items.map((item) => item.id)).toEqual(["old-reminder"]);

    await useNotificationsStore.getState().loadFor("user-1", { force: true });
    expect(useNotificationsStore.getState().items[0].id).toBe("salmon-escalation");
    expect(selectUnreadNotificationCount(useNotificationsStore.getState())).toBe(2);
  });

  it("the app's live refresh reloads alerts when the tab becomes visible again, with no push message", async () => {
    const { registerTasksLiveRefresh } = await import("../lib/tasks-live-refresh");
    listMock.mockResolvedValueOnce([notification("old-reminder")]);
    await useNotificationsStore.getState().loadFor("user-1");

    const listeners = new Map<string, () => void>();
    const documentApi = {
      visibilityState: "hidden" as DocumentVisibilityState,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const cleanup = registerTasksLiveRefresh({
      documentApi: documentApi as never,
      serviceWorkerApi: null,
      refetch: () => useNotificationsStore.getState().loadFor("user-1", { force: true }),
    });

    listMock.mockResolvedValueOnce([
      notification("salmon-escalation"),
      notification("old-reminder"),
    ]);
    documentApi.visibilityState = "visible";
    listeners.get("visibilitychange")?.();
    await vi.waitFor(() => expect(useNotificationsStore.getState().items[0]?.id).toBe("salmon-escalation"));
    cleanup();
  });
});

describe("a reload in flight cannot undo a read or a dismissal", () => {
  it("keeps a dismissed alert hidden when an older reload lands after the dismissal", async () => {
    listMock.mockResolvedValueOnce([notification("salmon"), notification("reminder")]);
    await useNotificationsStore.getState().loadFor("user-1");

    const inFlight = deferred<OwnerNotification[]>();
    listMock.mockReturnValueOnce(inFlight.promise);
    const reload = useNotificationsStore.getState().loadFor("user-1", { force: true });
    await useNotificationsStore.getState().dismiss("salmon");
    // The server answered the reload before the dismissal committed.
    inFlight.resolve([notification("salmon"), notification("reminder")]);
    await reload;

    expect(useNotificationsStore.getState().items.map((item) => item.id)).toEqual(["reminder"]);
  });

  it("keeps a read alert read (and the badge down) when an older reload lands after the read", async () => {
    listMock.mockResolvedValueOnce([notification("salmon")]);
    await useNotificationsStore.getState().loadFor("user-1");

    const inFlight = deferred<OwnerNotification[]>();
    listMock.mockReturnValueOnce(inFlight.promise);
    const reload = useNotificationsStore.getState().loadFor("user-1", { force: true });
    await useNotificationsStore.getState().markRead("salmon");
    inFlight.resolve([notification("salmon")]);
    await reload;

    expect(useNotificationsStore.getState().items[0].read_at).not.toBeNull();
    expect(selectUnreadNotificationCount(useNotificationsStore.getState())).toBe(0);
  });

  // Only alerts the owner saw as unread are re-applied as read. An alert that
  // was absent from the local list keeps whatever the next load reports.
  it("mark-all-read survives an older reload for the alerts the owner saw", async () => {
    listMock.mockResolvedValueOnce([notification("a"), notification("b")]);
    await useNotificationsStore.getState().loadFor("user-1");

    const inFlight = deferred<OwnerNotification[]>();
    listMock.mockReturnValueOnce(inFlight.promise);
    const reload = useNotificationsStore.getState().loadFor("user-1", { force: true });
    await useNotificationsStore.getState().markAllRead();
    inFlight.resolve([notification("new-escalation"), notification("a"), notification("b")]);
    await reload;

    const items = useNotificationsStore.getState().items;
    expect(items.find((item) => item.id === "a")?.read_at).not.toBeNull();
    expect(items.find((item) => item.id === "b")?.read_at).not.toBeNull();
    expect(items.find((item) => item.id === "new-escalation")?.read_at).toBeNull();
  });

  it("does not hide anything when the dismissal failed on the server", async () => {
    listMock.mockResolvedValueOnce([notification("salmon")]);
    await useNotificationsStore.getState().loadFor("user-1");
    dismissMock.mockRejectedValueOnce(new Error("offline"));
    await expect(useNotificationsStore.getState().dismiss("salmon")).rejects.toThrow("offline");

    listMock.mockResolvedValueOnce([notification("salmon")]);
    await useNotificationsStore.getState().loadFor("user-1", { force: true });
    expect(useNotificationsStore.getState().items.map((item) => item.id)).toEqual(["salmon"]);
  });

  it("forgets confirmed mutations on sign-out so another account is unaffected", async () => {
    listMock.mockResolvedValueOnce([notification("shared-id")]);
    await useNotificationsStore.getState().loadFor("user-1");
    await useNotificationsStore.getState().dismiss("shared-id");

    useNotificationsStore.getState().reset();
    listMock.mockResolvedValueOnce([notification("shared-id", null, "user-2")]);
    await useNotificationsStore.getState().loadFor("user-2");
    expect(useNotificationsStore.getState().items.map((item) => item.id)).toEqual(["shared-id"]);
  });
});
