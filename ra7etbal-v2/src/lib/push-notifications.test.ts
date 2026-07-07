import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSupabase = vi.hoisted(() => ({
  savedLookup: null as { id: string } | null,
  saveLookup: null as { id: string } | null,
  updates: [] as Array<{ table: string; patch: unknown; filters: Array<[string, unknown]> }>,
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
          const updateState = { table, patch, filters: [] as Array<[string, unknown]> };
          const chain = {
            eq(column: string, value: unknown) {
              updateState.filters.push([column, value]);
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
});
