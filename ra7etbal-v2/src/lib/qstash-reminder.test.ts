import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "token-abc" } },
        error: null,
      })),
    },
  },
}));

import { cancelReminderPush, rescheduleReminderPush, scheduleReminderPush } from "./qstash-reminder";

// System time frozen so "due in the future" fixtures below never go stale as
// real calendar time passes (they were previously hardcoded wall-clock
// dates that silently fell into the past and started failing).
const FROZEN_NOW = new Date("2026-01-01T00:00:00.000Z");
const FUTURE_DUE_AT = new Date(FROZEN_NOW.getTime() + 60 * 60 * 1000).toISOString(); // +1 hour

/**
 * Protected behavior (item 9): a QStash scheduling failure must never cause
 * the app to claim the reminder was successfully scheduled — and, just as
 * importantly, must never surface as a thrown error either. This module's
 * own doc comment states the contract: "fire-and-log: errors are caught and
 * logged... so that a QStash failure never blocks a task mutation from
 * completing." createReminderTask (src/lib/reminders.ts) calls
 * scheduleReminderPush without awaiting it, with only a defensive
 * `.catch(console.error)` as a backstop — that backstop is never actually
 * needed in practice because this function itself never rejects. These tests
 * lock that guarantee directly at the true I/O boundary (a mocked global
 * fetch), so a future change can't accidentally let a QStash failure
 * propagate up and falsely fail (or falsely succeed) the reminder creation
 * that already happened.
 */
describe("scheduleReminderPush — a QStash scheduling failure never throws and never claims success", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves (does not throw) when the API responds with a non-ok status, and logs the failure instead of hiding it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ success: false, error: "QStash is down" }),
      })),
    );

    await expect(
      scheduleReminderPush("task-1", FUTURE_DUE_AT),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[qstash-reminder] API ERROR"),
      expect.objectContaining({ success: false, error: "QStash is down" }),
    );
  });

  it("resolves (does not throw) when the network request itself rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const networkError = new Error("network down");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw networkError;
      }),
    );

    await expect(
      scheduleReminderPush("task-1", FUTURE_DUE_AT),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[qstash-reminder] fetch failed (network error):",
      "schedule",
      "task-1",
      networkError,
    );
  });

  it("never calls the API at all for an unparseable dueAt — no call means no possible false success claim", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await scheduleReminderPush("task-1", "not-a-date");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[qstash-reminder] Invalid dueAt — cannot schedule:",
      "not-a-date",
    );
  });

  it("resolves the same way (undefined, no throw) on success — callers cannot distinguish success from failure through this promise, by design", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, action: "scheduled", messageId: "msg-1" }),
      })),
    );

    await expect(
      scheduleReminderPush("task-1", FUTURE_DUE_AT),
    ).resolves.toBeUndefined();
  });
});

describe("cancelReminderPush / rescheduleReminderPush — same fire-and-log contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cancelReminderPush never throws on an API failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })),
    );

    await expect(cancelReminderPush("task-1")).resolves.toBeUndefined();
  });

  it("rescheduleReminderPush never throws on an API failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })),
    );

    await expect(
      rescheduleReminderPush("task-1", FUTURE_DUE_AT),
    ).resolves.toBeUndefined();
  });
});
