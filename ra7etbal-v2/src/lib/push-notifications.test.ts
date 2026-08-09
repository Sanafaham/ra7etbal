import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The save/dedupe path now goes through a single atomic RPC
 * (upsert_push_subscription, migration
 * 20260810_push_subscription_installation_identity.sql) instead of
 * separate select/insert/update + a client-side dedupe pass. The old
 * platform-scoped dedupe tests (multi-device collision risk, non-atomic
 * race) are removed rather than preserved — that behavior no longer
 * exists in this file; its replacement is proven for real in the
 * migration's own ephemeral-Postgres verification suite
 * (supabase/migrations/verification/push_subscriptions_*.sql), which is
 * the only place that can genuinely prove the RPC's concurrency/atomicity
 * guarantees. This file only proves the client calls that RPC correctly
 * and propagates its result truthfully.
 */

const mockSupabase = vi.hoisted(() => ({
  savedLookup: null as { id: string } | null,
  disableUpdates: [] as Array<{ patch: unknown; filters: Array<[string, unknown]> }>,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  rpcError: null as { message: string } | null,
}));

vi.mock("./supabase", () => ({
  supabase: {
    from(table: string) {
      const state = { table, filters: [] as Array<[string, unknown]> };
      return {
        select() {
          return this;
        },
        eq(column: string, value: unknown) {
          state.filters.push([column, value]);
          return this;
        },
        async maybeSingle() {
          return { data: mockSupabase.savedLookup, error: null };
        },
        // disableSavedPushSubscription's plain "mark the old browser token
        // disabled before requesting a fresh one" write — unrelated to and
        // unchanged by the upsert_push_subscription RPC.
        update(patch: unknown) {
          const updateState = { patch, filters: [] as Array<[string, unknown]> };
          const chain = {
            eq(column: string, value: unknown) {
              updateState.filters.push([column, value]);
              return chain;
            },
            then(resolve: (value: { error: null }) => void) {
              mockSupabase.disableUpdates.push({ ...updateState });
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
    async rpc(name: string, args: unknown) {
      mockSupabase.rpcCalls.push({ name, args });
      return { data: mockSupabase.rpcError ? null : [{ id: "row-1", superseded_count: 0 }], error: mockSupabase.rpcError };
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

/** A minimal, real-enough localStorage backed by a plain object. */
function makeLocalStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    _store: store,
  };
}

async function importPushModule() {
  vi.resetModules();
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "BEl7____________________________________________________________");
  return import("./push-notifications");
}

describe("push notifications — installation-identity RPC save path", () => {
  let localStorageMock: ReturnType<typeof makeLocalStorage>;

  beforeEach(() => {
    mockSupabase.savedLookup = null;
    mockSupabase.disableUpdates.length = 0;
    mockSupabase.rpcCalls.length = 0;
    mockSupabase.rpcError = null;

    const PushManagerMock = function PushManager() {};
    const NotificationMock = {
      permission: "granted",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    };
    vi.stubGlobal("PushManager", PushManagerMock);
    vi.stubGlobal("Notification", NotificationMock);
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });

    localStorageMock = makeLocalStorage();

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        isSecureContext: true,
        PushManager: PushManagerMock,
        Notification: NotificationMock,
        localStorage: localStorageMock,
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

  it("enableReminderNotifications calls the RPC once with a generated, persisted installation_id", async () => {
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

    expect(mockSupabase.rpcCalls).toHaveLength(1);
    expect(mockSupabase.rpcCalls[0]).toEqual({
      name: "upsert_push_subscription",
      args: {
        p_endpoint: "https://push.example/fresh",
        p_p256dh: expect.any(String),
        p_auth: expect.any(String),
        p_expiration_time: null,
        p_user_agent: "Mozilla/5.0 iPhone PWA",
        p_platform: "iPhone",
        p_installation_id: "11111111-1111-4111-8111-111111111111",
      },
    });
    // Persisted for reuse — see the "reload reuse" test below for direct proof.
    expect(localStorageMock.getItem("ra7etbal:push-installation-id")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("does not replace an existing subscription that is already enabled for the user, but still calls the RPC to refresh it", async () => {
    mockSupabase.savedLookup = { id: "sub-1" };
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
    expect(mockSupabase.rpcCalls).toHaveLength(1);
    expect(mockSupabase.rpcCalls[0].args).toMatchObject({ p_endpoint: "https://push.example/current" });
  });

  it("refresh unsubscribes the old browser token, subscribes fresh, and calls the RPC with the new endpoint", async () => {
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
    expect(mockSupabase.rpcCalls).toHaveLength(1);
    expect(mockSupabase.rpcCalls[0].args).toMatchObject({ p_endpoint: "https://push.example/new" });
  });

  it("reload reuse: the same installation_id is sent across two separate saves in the same storage partition", async () => {
    const first = makeSubscription("https://push.example/first");
    const second = makeSubscription("https://push.example/second");
    const registration = {
      active: true,
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      },
    };
    navigator.serviceWorker.getRegistration = vi.fn().mockResolvedValue(registration);

    const { enableReminderNotifications, refreshPushSubscription } = await importPushModule();
    await enableReminderNotifications("user-1");
    await refreshPushSubscription("user-1");

    expect(mockSupabase.rpcCalls).toHaveLength(2);
    expect(mockSupabase.rpcCalls[0].args).toMatchObject({ p_installation_id: "11111111-1111-4111-8111-111111111111" });
    expect(mockSupabase.rpcCalls[1].args).toMatchObject({ p_installation_id: "11111111-1111-4111-8111-111111111111" });
  });

  it("localStorage failure sends installation_id: null rather than a fresh ephemeral UUID per call", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: localStorage is disabled");
      },
    });

    const fresh = makeSubscription("https://push.example/no-storage");
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

    expect(mockSupabase.rpcCalls[0].args).toMatchObject({ p_installation_id: null });
  });

  it("RPC failure rejects enableReminderNotifications — never falsely reports 'enabled'", async () => {
    mockSupabase.rpcError = { message: "advisory lock / upsert failed" };
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
    await expect(enableReminderNotifications("user-1")).rejects.toEqual({
      message: "advisory lock / upsert failed",
    });
  });

  it("RPC failure rejects refreshPushSubscription the same way", async () => {
    mockSupabase.rpcError = { message: "advisory lock / upsert failed" };
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
    await expect(refreshPushSubscription("user-1")).rejects.toEqual({
      message: "advisory lock / upsert failed",
    });
  });

  it("saveRawPushSubscription (the pushsubscriptionchange path) calls the RPC with the rotated subscription's fields", async () => {
    const { saveRawPushSubscription } = await importPushModule();

    await saveRawPushSubscription("user-1", {
      endpoint: "https://push.example/rotated",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
      expirationTime: null,
    });

    expect(mockSupabase.rpcCalls).toHaveLength(1);
    expect(mockSupabase.rpcCalls[0]).toEqual({
      name: "upsert_push_subscription",
      args: {
        p_endpoint: "https://push.example/rotated",
        p_p256dh: "p256dh-value",
        p_auth: "auth-value",
        p_expiration_time: null,
        p_user_agent: "Mozilla/5.0 iPhone PWA",
        p_platform: "iPhone",
        p_installation_id: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("saveRawPushSubscription rejects a payload missing required fields, without calling the RPC", async () => {
    const { saveRawPushSubscription } = await importPushModule();

    await expect(
      saveRawPushSubscription("user-1", {
        endpoint: "",
        keys: { p256dh: "", auth: "" },
      }),
    ).rejects.toThrow();
    expect(mockSupabase.rpcCalls).toHaveLength(0);
  });

  it("saveRawPushSubscription propagates an RPC failure truthfully", async () => {
    mockSupabase.rpcError = { message: "advisory lock / upsert failed" };
    const { saveRawPushSubscription } = await importPushModule();

    await expect(
      saveRawPushSubscription("user-1", {
        endpoint: "https://push.example/rotated",
        keys: { p256dh: "p256dh-value", auth: "auth-value" },
        expirationTime: null,
      }),
    ).rejects.toEqual({ message: "advisory lock / upsert failed" });
  });
});
