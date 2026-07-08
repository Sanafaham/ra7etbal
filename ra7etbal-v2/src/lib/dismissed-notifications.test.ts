import { describe, expect, it } from "vitest";
import {
  dismissedStorageKey,
  readDismissedIds,
  selectConfirmationNotices,
  writeDismissedIds,
  type DismissedStorage,
} from "./dismissed-notifications";
import type { Task } from "../types/task";

/** In-memory stand-in for window.localStorage — persists across calls,
 * exactly like real localStorage persists across a reload or a
 * logout→login cycle within the same browser. */
function makeFakeStorage(): DismissedStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const NOW = new Date("2026-07-09T12:00:00.000Z");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "plate the chicken",
    type: "delegation",
    assigned_to: "Christopher",
    status: "done",
    needs_follow_up: false,
    confirmation_url: "https://ra7etbal.com/confirm?task=task-1",
    confirmed_at: NOW.toISOString(),
    due_at: null,
    archived_at: null,
    created_at: "2026-07-09T10:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    ...overrides,
  } as Task;
}

describe("dismissed-notifications storage — survives reload and logout/login", () => {
  it("a dismissed id is still dismissed on a fresh read within the same session (reload)", () => {
    const storage = makeFakeStorage();
    writeDismissedIds(storage, "user-1", new Set(["task-1"]));

    // A fresh read call — as if the page reloaded and the hook re-read from
    // scratch — must still see the dismissal.
    const afterReload = readDismissedIds(storage, "user-1");
    expect(afterReload.has("task-1")).toBe(true);
  });

  it("a dismissed id is still dismissed after the userId cycles through null and back (logout then login)", () => {
    const storage = makeFakeStorage();
    writeDismissedIds(storage, "user-1", new Set(["task-1"]));

    // Logout: the hook's effect runs with userId=null and never touches
    // storage for user-1 at all — nothing should be cleared.
    const duringLoggedOut = readDismissedIds(storage, "user-1");
    expect(duringLoggedOut.has("task-1")).toBe(true);

    // Login as the same user again: a brand new read against the same
    // storage and same userId — must still return the dismissal.
    const afterLogin = readDismissedIds(storage, "user-1");
    expect(afterLogin.has("task-1")).toBe(true);
  });

  it("regression: dismissal survives even when accumulated across several dismiss calls, mirroring dismiss() in the hook", () => {
    const storage = makeFakeStorage();
    let dismissed = readDismissedIds(storage, "user-1");
    expect(dismissed.size).toBe(0);

    dismissed = new Set(dismissed).add("task-1");
    writeDismissedIds(storage, "user-1", dismissed);

    dismissed = readDismissedIds(storage, "user-1");
    dismissed = new Set(dismissed).add("task-2");
    writeDismissedIds(storage, "user-1", dismissed);

    // Simulate logout/login: read fresh from storage again.
    const restored = readDismissedIds(storage, "user-1");
    expect(restored.has("task-1")).toBe(true);
    expect(restored.has("task-2")).toBe(true);
    expect(restored.size).toBe(2);
  });

  it("dismissing one id does not affect a different id (only the specific banner is dismissed)", () => {
    const storage = makeFakeStorage();
    writeDismissedIds(storage, "user-1", new Set(["task-1"]));

    const dismissed = readDismissedIds(storage, "user-1");
    expect(dismissed.has("task-1")).toBe(true);
    expect(dismissed.has("task-2")).toBe(false);
  });

  it("is scoped per user — one account's dismissal never bleeds into another's", () => {
    const storage = makeFakeStorage();
    writeDismissedIds(storage, "user-1", new Set(["task-1"]));

    const otherUser = readDismissedIds(storage, "user-2");
    expect(otherUser.has("task-1")).toBe(false);
    expect(otherUser.size).toBe(0);
    expect(dismissedStorageKey("user-1")).not.toBe(dismissedStorageKey("user-2"));
  });

  it("a storage write that throws (private/incognito mode, quota exceeded) is reported as failed, not silently treated as success", () => {
    const throwingStorage: DismissedStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const ok = writeDismissedIds(throwingStorage, "user-1", new Set(["task-1"]));
    expect(ok).toBe(false);
  });

  it("regression: a write that silently no-ops (setItem succeeds but does not round-trip) is now detected as a failure", () => {
    // Previously writeDismissed() trusted setItem unconditionally — this
    // reproduces the exact silent-failure gap: setItem does not throw, but
    // the value read back afterward does not match what was written.
    const flakyStorage: DismissedStorage = {
      getItem: () => "not-what-was-written",
      setItem: () => {
        /* pretend this "succeeds" without actually persisting */
      },
    };
    const ok = writeDismissedIds(flakyStorage, "user-1", new Set(["task-1"]));
    expect(ok).toBe(false);
  });

  it("a corrupted or non-array stored value degrades to an empty set instead of throwing", () => {
    const storage = makeFakeStorage();
    storage.data.set(dismissedStorageKey("user-1"), "{ not json");
    expect(() => readDismissedIds(storage, "user-1")).not.toThrow();
    expect(readDismissedIds(storage, "user-1").size).toBe(0);

    storage.data.set(dismissedStorageKey("user-1"), JSON.stringify({ not: "an array" }));
    expect(readDismissedIds(storage, "user-1").size).toBe(0);
  });
});

describe("selectConfirmationNotices — active/unresolved items are never hidden", () => {
  it("a dismissed, done, confirmed task is excluded", () => {
    const task = makeTask({ id: "task-1" });
    const visible = selectConfirmationNotices([task], new Set(["task-1"]));
    expect(visible.map((t) => t.id)).not.toContain("task-1");
  });

  it("a done, confirmed task that has NOT been dismissed still appears", () => {
    const task = makeTask({ id: "task-1" });
    const visible = selectConfirmationNotices([task], new Set());
    expect(visible.map((t) => t.id)).toContain("task-1");
  });

  it("protected: a pending (unresolved, not yet confirmed) delegation never appears, dismissed or not", () => {
    const pending = makeTask({ id: "task-pending", status: "pending", confirmed_at: null });
    expect(selectConfirmationNotices([pending], new Set()).map((t) => t.id)).not.toContain(
      "task-pending",
    );
    expect(
      selectConfirmationNotices([pending], new Set(["task-pending"])).map((t) => t.id),
    ).not.toContain("task-pending");
  });

  it("protected: a done task with no confirmed_at (e.g. owner marked done directly) never appears", () => {
    const selfDone = makeTask({ id: "task-self", confirmed_at: null });
    expect(selectConfirmationNotices([selfDone], new Set()).map((t) => t.id)).not.toContain(
      "task-self",
    );
  });

  it("dismissing one task's banner does not hide a different, unresolved-relative task's banner", () => {
    const dismissedTask = makeTask({ id: "task-1", confirmed_at: NOW.toISOString() });
    const activeTask = makeTask({
      id: "task-2",
      confirmed_at: new Date(NOW.getTime() + 1000).toISOString(),
    });
    const visible = selectConfirmationNotices(
      [dismissedTask, activeTask],
      new Set(["task-1"]),
    );
    expect(visible.map((t) => t.id)).toEqual(["task-2"]);
  });
});
