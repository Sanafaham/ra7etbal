import { describe, expect, it, vi } from "vitest";

// registerPushSubscriptionRotation's default saveRawPushSubscriptionFn comes
// from push-notifications.ts, which imports the real Supabase client at
// module load time. Every test here injects its own saveRawPushSubscriptionFn,
// so the real module is never needed — mocked purely to keep the import graph
// free of Supabase env-var requirements.
vi.mock("./push-notifications", () => ({ saveRawPushSubscription: vi.fn() }));

import {
  PUSH_SUBSCRIPTION_CHANGED_MESSAGE_TYPE,
  registerPushSubscriptionRotation,
} from "./push-subscription-rotation";

function makeFakeServiceWorker() {
  const listeners: Array<(event: MessageEvent) => void> = [];
  return {
    addEventListener: vi.fn((_type: "message", listener: (event: MessageEvent) => void) => {
      listeners.push(listener);
    }),
    removeEventListener: vi.fn((_type: "message", listener: (event: MessageEvent) => void) => {
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
    // Test helper — not part of the real ServiceWorkerContainer API.
    fireMessage(data: unknown) {
      listeners.forEach((l) => l({ data } as MessageEvent));
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

const validSubscription = {
  endpoint: "https://push.example/rotated",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
  expirationTime: null,
};

describe("registerPushSubscriptionRotation — pushsubscriptionchange bridge", () => {
  it("saves the rotated subscription reported by the service worker", () => {
    const serviceWorkerApi = makeFakeServiceWorker();
    const saveRawPushSubscriptionFn = vi.fn().mockResolvedValue(undefined);
    registerPushSubscriptionRotation({ serviceWorkerApi, userId: "user-1", saveRawPushSubscriptionFn });

    serviceWorkerApi.fireMessage({
      type: PUSH_SUBSCRIPTION_CHANGED_MESSAGE_TYPE,
      subscription: validSubscription,
    });

    expect(saveRawPushSubscriptionFn).toHaveBeenCalledWith("user-1", validSubscription);
  });

  it("logs (never throws) when saving the rotated subscription fails — no UI status exists for this background path, so this is the only surfacing", async () => {
    const serviceWorkerApi = makeFakeServiceWorker();
    const saveError = new Error("dedupe update failed");
    const saveRawPushSubscriptionFn = vi.fn().mockRejectedValue(saveError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerPushSubscriptionRotation({ serviceWorkerApi, userId: "user-1", saveRawPushSubscriptionFn });

    expect(() =>
      serviceWorkerApi.fireMessage({
        type: PUSH_SUBSCRIPTION_CHANGED_MESSAGE_TYPE,
        subscription: validSubscription,
      }),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("Failed to save rotated push subscription", saveError);
    });
    errorSpy.mockRestore();
  });

  it("ignores unrelated service worker messages", () => {
    const serviceWorkerApi = makeFakeServiceWorker();
    const saveRawPushSubscriptionFn = vi.fn();
    registerPushSubscriptionRotation({ serviceWorkerApi, userId: "user-1", saveRawPushSubscriptionFn });

    serviceWorkerApi.fireMessage({ type: "ra7etbal:push-received" });
    serviceWorkerApi.fireMessage(undefined);

    expect(saveRawPushSubscriptionFn).not.toHaveBeenCalled();
  });

  it("ignores a malformed subscription payload rather than throwing", () => {
    const serviceWorkerApi = makeFakeServiceWorker();
    const saveRawPushSubscriptionFn = vi.fn();
    registerPushSubscriptionRotation({ serviceWorkerApi, userId: "user-1", saveRawPushSubscriptionFn });

    expect(() =>
      serviceWorkerApi.fireMessage({ type: PUSH_SUBSCRIPTION_CHANGED_MESSAGE_TYPE, subscription: null }),
    ).not.toThrow();
    expect(saveRawPushSubscriptionFn).not.toHaveBeenCalled();
  });

  it("works with no service worker available without throwing", () => {
    expect(() =>
      registerPushSubscriptionRotation({
        serviceWorkerApi: null,
        userId: "user-1",
        saveRawPushSubscriptionFn: vi.fn(),
      }),
    ).not.toThrow();
  });

  it("cleanup removes the listener so a later rotation is never saved", () => {
    const serviceWorkerApi = makeFakeServiceWorker();
    const saveRawPushSubscriptionFn = vi.fn();
    const cleanup = registerPushSubscriptionRotation({
      serviceWorkerApi,
      userId: "user-1",
      saveRawPushSubscriptionFn,
    });

    cleanup();
    serviceWorkerApi.fireMessage({
      type: PUSH_SUBSCRIPTION_CHANGED_MESSAGE_TYPE,
      subscription: validSubscription,
    });

    expect(saveRawPushSubscriptionFn).not.toHaveBeenCalled();
    expect(serviceWorkerApi.listenerCount()).toBe(0);
  });
});
