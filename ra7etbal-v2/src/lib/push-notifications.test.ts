import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSupabase = vi.hoisted(() => ({
  savedLookup: null as { id: string } | null,
  saveLookup: null as { id: string } | null,
  updates: [] as Array<{
    table: string;
    patch: unknown;
    filters: Array<[string, unknown] | [string, unknown, "neq"]>;
  }>,
  inserts: [] as Array<{ table: string; row: unknown }>,
  selects: [] as Array<{ table: string; column: string; filters: Array<[string, unknown]> }>,
}));

vi.mock("./supabase", () => ({
  supabase: {
    from(table: string) {
      const state = { table, column: "", filters: [] as Array<[string, unknown]> };
      return {
        select(column: string) {
          state.column = column;
          return this;
        },
        eq(column: string, value: unknown) {
          state.filters.push([column, value]);
          return this;
        },
        async maybeSingle() {
          mockSupabase.selects.push({ ...state });
          const hasEnabledFilter = state.filters.some(
            ([column, value]) => column === "enabled" && value === true,
          );
          return {
            data: hasEnabledFilter ? mockSupabase.savedLookup : mockSupabase.saveLookup,
            error: null,
          };
        },
        update(patch: unknown) {
          const updateState = { table, patch, filters: [] as Array<[string, unknown] | [string, unknown, "neq"]> };
          const chain = {
            eq(column: string, value: unknown) {
              updateState.filters.push([column, value]);
              return chain;
            },
            neq(column: string, value: unknown) {
              updateState.filters.push([column, value, "neq"]);
              return chain;
            },
            then(resolve: (value: { error: null }) => void) {
              mockSupabase.updates.push({ ...updateState });
              resolve({ error: null });
            },
          };
          return chain;
        },
        insert(row: unknown) {
          mockSupabase.inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  },
}));

interface MockPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  getKey: (name: "p256dh" | "auth") => ArrayBuffer | null;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function makeSubscription(endpoint: string): MockPushSubscription {
  return {
    endpoint,
    expirationTime: null,
    getKey: (name) => new TextEncoder().encode(`${endpoint}-${name}`).buffer,
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

async function importPushModule() {
  vi.resetModules();
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "BEl7____________________________________________________________");
  return import("./push-notifications");
}

describe("push notifications — iPhone PWA subscription recovery", () => {
  beforeEach(() => {
    mockSupabase.savedLookup = null;
    mockSupabase.saveLookup = null;
    mockSupabase.updates.length = 0;
    mockSupabase.inserts.length = 0;
    mockSupabase.selects.length = 0;

    const PushManagerMock = function PushManager() {};
    const NotificationMock = {
      permission: "granted",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    };
    vi.stubGlobal("PushManager", PushManagerMock);
    vi.stubGlobal("Notification", NotificationMock);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        isSecureContext: true,
        PushManager: PushManagerMock,
        Notification: NotificationMock,
        atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
        btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgent: "Mozilla/5.0 iPhone PWA",
        platform: "iPhone",
        serviceWorker: {},
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("re-enabling after the DB row is off replaces the stale browser subscription before saving", async () => {
    const stale = makeSubscription("https://push.example/stale");
    const fresh = makeSubscription("https://push.example/fresh");
    const registration = {
      active: true,
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(stale),
        subscribe: vi.fn().mockResolvedValue(fresh),
      },
    };
    navigator.serviceWorker.getRegistration = vi.fn().mockResolvedValue(registration);

    const { enableReminderNotifications } = await importPushModule();

    await expect(enableReminderNotifications("user-1")).resolves.toBe("enabled");

    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(mockSupabase.updates).toContainEqual({
      table: "push_subscriptions",
      patch: { enabled: false },
      filters: [["user_id", "user-1"], ["endpoint", "https://push.example/stale"]],
    });
    // Dedupe pass after the save: supersede any other enabled iPhone rows
    // for this user except the endpoint just saved.
    expect(mockSupabase.updates).toContainEqual({
      table: "push_subscriptions",
      patch: { enabled: false },
      filters: [
        ["user_id", "user-1"],
        ["platform", "iPhone"],
        ["enabled", true],
        ["endpoint", "https://push.example/fresh", "neq"],
      ],
    });
    expect(mockSupabase.inserts[0]).toMatchObject({
      table: "push_subscriptions",
      row: expect.objectContaining({
        user_id: "user-1",
        endpoint: "https://push.example/fresh",
        enabled: true,
        platform: "iPhone",
      }),
    });
  });

  it("does not replace an existing subscription that is already enabled for the user", async () => {
    mockSupabase.savedLookup = { id: "sub-1" };
    mockSupabase.saveLookup = { id: "sub-1" };
    const existing = makeSubscription("https://push.example/current");
    const registration = {
      active: true,
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(existing),
        subscribe: vi.fn(),
      },
    };
    navigator.serviceWorker.getRegistration = vi.fn().mockResolvedValue(registration);

    const { enableReminderNotifications } = await importPushModule();

    await expect(enableReminderNotifications("user-1")).resolves.toBe("enabled");

    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(mockSupabase.updates).toEqual([
      {
        table: "push_subscriptions",
        patch: expect.objectContaining({
          endpoint: "https://push.example/current",
          enabled: true,
        }),
        filters: [["id", "sub-1"]],
      },
      {
        table: "push_subscriptions",
        patch: { enabled: false },
        filters: [
          ["user_id", "user-1"],
          ["platform", "iPhone"],
          ["enabled", true],
          ["endpoint", "https://push.example/current", "neq"],
        ],
      },
    ]);
  });

  it("refresh disables the old saved endpoint before saving the new one", async () => {
    const oldSub = makeSubscription("https://push.example/old");
    const newSub = makeSubscription("https://push.example/new");
    const registration = {
      active: true,
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(oldSub),
        subscribe: vi.fn().mockResolvedValue(newSub),
      },
    };
    navigator.serviceWorker.getRegistration = vi.fn().mockResolvedValue(registration);

    const { refreshPushSubscription } = await importPushModule();

    await expect(refreshPushSubscription("user-1")).resolves.toBe("enabled");

    expect(oldSub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(mockSupabase.updates[0]).toEqual({
      table: "push_subscriptions",
      patch: { enabled: false },
      filters: [["user_id", "user-1"], ["endpoint", "https://push.example/old"]],
    });
    expect(mockSupabase.inserts[0].row).toEqual(
      expect.objectContaining({
        endpoint: "https://push.example/new",
        enabled: true,
      }),
    );
  });

  it("dedupes accumulated dead rows: disables every other enabled row for the same platform, never a different one", async () => {
    const fresh = makeSubscription("https://push.example/fresh");
    const registration = {
      active: true,
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(fresh),
      },
    };
    navigator.serviceWorker.getRegistration = vi.fn().mockResolvedValue(registration);

    const { enableReminderNotifications } = await importPushModule();
    await expect(enableReminderNotifications("user-1")).resolves.toBe("enabled");

    // Insert (no prior saved subscription for this endpoint), then the
    // dedupe pass — scoped to this user's iPhone rows only, never MacIntel
    // or another user's rows, which the mock doesn't even model (proving
    // the query itself, not just the mock, is user_id + platform scoped).
    expect(mockSupabase.updates).toEqual([
      {
        table: "push_subscriptions",
        patch: { enabled: false },
        filters: [
          ["user_id", "user-1"],
          ["platform", "iPhone"],
          ["enabled", true],
          ["endpoint", "https://push.example/fresh", "neq"],
        ],
      },
    ]);
  });

  it("saveRawPushSubscription (the pushsubscriptionchange path) persists the rotated subscription and dedupes the same way as a normal save", async () => {
    const { saveRawPushSubscription } = await importPushModule();

    await saveRawPushSubscription("user-1", {
      endpoint: "https://push.example/rotated",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
      expirationTime: null,
    });

    expect(mockSupabase.inserts[0]).toMatchObject({
      table: "push_subscriptions",
      row: expect.objectContaining({
        user_id: "user-1",
        endpoint: "https://push.example/rotated",
        p256dh: "p256dh-value",
        auth: "auth-value",
        enabled: true,
        platform: "iPhone",
      }),
    });
    expect(mockSupabase.updates).toContainEqual({
      table: "push_subscriptions",
      patch: { enabled: false },
      filters: [
        ["user_id", "user-1"],
        ["platform", "iPhone"],
        ["enabled", true],
        ["endpoint", "https://push.example/rotated", "neq"],
      ],
    });
  });

  it("saveRawPushSubscription rejects a payload missing required fields", async () => {
    const { saveRawPushSubscription } = await importPushModule();

    await expect(
      saveRawPushSubscription("user-1", {
        endpoint: "",
        keys: { p256dh: "", auth: "" },
      }),
    ).rejects.toThrow();
    expect(mockSupabase.inserts).toHaveLength(0);
    expect(mockSupabase.updates).toHaveLength(0);
  });
});
