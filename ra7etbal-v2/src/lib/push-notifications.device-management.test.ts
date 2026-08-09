import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Push Subscription Installation Management / Orphan Resolution —
 * listPushSubscriptionDevices / removePushSubscriptionDevice. Separate
 * mock/file from push-notifications.test.ts (whose mock is shaped only
 * for the save/RPC path) so this feature's queries don't have to fight
 * that file's narrower chain support.
 */

interface MockRow {
  id: string;
  platform: string | null;
  user_agent: string | null;
  installation_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MockEventRow {
  subscription_id: string | null;
  event_at: string | null;
}

const mockState = vi.hoisted(() => ({
  subscriptionRows: [] as MockRow[],
  subscriptionsError: null as { message: string } | null,
  eventRows: [] as MockEventRow[],
  eventsError: null as { message: string } | null,
  updateResultRows: [] as Array<{ id: string }>,
  updateError: null as { message: string } | null,
  updateCalls: [] as Array<{ patch: unknown; filters: Array<[string, unknown]> }>,
}));

vi.mock("./supabase", () => ({
  supabase: {
    from(table: string) {
      if (table === "push_subscriptions") {
        return {
          select() {
            const filters: Array<[string, unknown]> = [];
            const builder = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              order() {
                return builder;
              },
              then(resolve: (v: { data: MockRow[] | null; error: unknown }) => void) {
                resolve({ data: mockState.subscriptionRows, error: mockState.subscriptionsError });
              },
            };
            return builder;
          },
          update(patch: unknown) {
            const filters: Array<[string, unknown]> = [];
            const builder = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              select() {
                mockState.updateCalls.push({ patch, filters: [...filters] });
                return {
                  then(resolve: (v: { data: Array<{ id: string }> | null; error: unknown }) => void) {
                    resolve({ data: mockState.updateError ? null : mockState.updateResultRows, error: mockState.updateError });
                  },
                };
              },
            };
            return builder;
          },
        };
      }
      if (table === "reminder_delivery_events") {
        return {
          select() {
            const builder = {
              eq() {
                return builder;
              },
              in() {
                return builder;
              },
              then(resolve: (v: { data: MockEventRow[] | null; error: unknown }) => void) {
                resolve({ data: mockState.eventRows, error: mockState.eventsError });
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`Unexpected table in mock: ${table}`);
    },
  },
}));

import { listPushSubscriptionDevices, removePushSubscriptionDevice } from "./push-notifications";

beforeEach(() => {
  mockState.subscriptionRows = [];
  mockState.subscriptionsError = null;
  mockState.eventRows = [];
  mockState.eventsError = null;
  mockState.updateResultRows = [];
  mockState.updateError = null;
  mockState.updateCalls = [];
});

describe("listPushSubscriptionDevices", () => {
  it("returns an empty list without querying delivery events when there are no enabled subscriptions", async () => {
    mockState.subscriptionRows = [];
    const result = await listPushSubscriptionDevices("user-1");
    expect(result).toEqual([]);
  });

  it("maps subscription rows and attaches the most recent show_notification_resolved event per subscription", async () => {
    mockState.subscriptionRows = [
      {
        id: "sub-a",
        platform: "iPhone",
        user_agent: "Mozilla/5.0 iPhone",
        installation_id: "install-1",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
      },
      {
        id: "sub-b",
        platform: "MacIntel",
        user_agent: "Mozilla/5.0 Mac",
        installation_id: null,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    ];
    mockState.eventRows = [
      { subscription_id: "sub-a", event_at: "2026-08-05T00:00:00Z" },
      { subscription_id: "sub-a", event_at: "2026-08-06T12:00:00Z" }, // later — must win
      { subscription_id: "sub-a", event_at: "2026-08-03T00:00:00Z" }, // earlier — must not win
    ];

    const result = await listPushSubscriptionDevices("user-1");

    expect(result).toEqual([
      {
        id: "sub-a",
        platform: "iPhone",
        userAgent: "Mozilla/5.0 iPhone",
        installationId: "install-1",
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-02T00:00:00Z",
        lastConfirmedDeliveredAt: "2026-08-06T12:00:00Z",
      },
      {
        id: "sub-b",
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 Mac",
        installationId: null,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        lastConfirmedDeliveredAt: null,
      },
    ]);
  });

  it("leaves lastConfirmedDeliveredAt null for a subscription with zero delivery events — never treats absence as death", async () => {
    mockState.subscriptionRows = [
      {
        id: "sub-orphan",
        platform: "iPhone",
        user_agent: "UA",
        installation_id: null,
        created_at: "2026-06-14T23:33:21Z",
        updated_at: "2026-06-14T23:33:21Z",
      },
    ];
    mockState.eventRows = [];

    const result = await listPushSubscriptionDevices("user-1");
    expect(result[0].lastConfirmedDeliveredAt).toBeNull();
  });

  it("propagates a subscriptions query error", async () => {
    mockState.subscriptionsError = { message: "network error" };
    await expect(listPushSubscriptionDevices("user-1")).rejects.toMatchObject({ message: "network error" });
  });

  it("propagates a delivery-events query error", async () => {
    mockState.subscriptionRows = [
      {
        id: "sub-a",
        platform: "iPhone",
        user_agent: "UA",
        installation_id: null,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
    ];
    mockState.eventsError = { message: "events failed" };
    await expect(listPushSubscriptionDevices("user-1")).rejects.toMatchObject({ message: "events failed" });
  });
});

describe("removePushSubscriptionDevice", () => {
  it("scopes the update by id and user_id and resolves when a row was affected", async () => {
    mockState.updateResultRows = [{ id: "sub-a" }];
    await removePushSubscriptionDevice("user-1", "sub-a");

    expect(mockState.updateCalls).toHaveLength(1);
    expect(mockState.updateCalls[0].patch).toEqual({ enabled: false });
    expect(mockState.updateCalls[0].filters).toEqual([
      ["id", "sub-a"],
      ["user_id", "user-1"],
    ]);
  });

  it("throws a truthful error instead of a false success when zero rows are affected", async () => {
    mockState.updateResultRows = [];
    await expect(removePushSubscriptionDevice("user-1", "sub-missing")).rejects.toThrow(
      /could not be found, or was already removed/i,
    );
  });

  it("propagates an update error", async () => {
    mockState.updateError = { message: "update failed" };
    await expect(removePushSubscriptionDevice("user-1", "sub-a")).rejects.toMatchObject({
      message: "update failed",
    });
  });
});
