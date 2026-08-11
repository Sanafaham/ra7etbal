import { describe, expect, it, vi } from "vitest";
import { markEveryOwnerNotificationRead, openOwnerNotification } from "./notification-actions";
import type { OwnerNotification } from "../types/notification";

describe("notification read actions", () => {
  it("marks one read before navigating", async () => {
    const order: string[] = [];
    await openOwnerNotification(notification(), {
      markRead: vi.fn(async () => { order.push("read"); }),
      navigate: vi.fn(() => { order.push("navigate"); }),
    });
    expect(order).toEqual(["read", "navigate"]);
  });

  it("does not navigate when marking one read fails", async () => {
    const navigate = vi.fn();
    await expect(openOwnerNotification(notification(), {
      markRead: vi.fn().mockRejectedValue(new Error("update failed")),
      navigate,
    })).rejects.toThrow("update failed");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("propagates a bulk read failure for recoverable UI feedback", async () => {
    await expect(markEveryOwnerNotificationRead(
      vi.fn().mockRejectedValue(new Error("bulk failed")),
    )).rejects.toThrow("bulk failed");
  });
});

function notification(): OwnerNotification {
  return {
    id: "notification-1", user_id: "user-1", event_key: "reminder_due:task-1",
    kind: "reminder_due", title: "Ra7etBal", body: "Check", occurred_at: "2026-08-11T20:00:00Z",
    read_at: null, target_type: "task", target_id: "task-1", target_url: "/updates?tab=todo",
    metadata: {}, created_at: "2026-08-11T20:00:00Z",
  };
}
