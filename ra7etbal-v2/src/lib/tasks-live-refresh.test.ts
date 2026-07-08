import { describe, expect, it, vi } from "vitest";
import { PUSH_RECEIVED_MESSAGE_TYPE, registerTasksLiveRefresh } from "./tasks-live-refresh";

function makeFakeDocument(initialVisibility: DocumentVisibilityState = "visible") {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    visibilityState: initialVisibility,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      (listeners[type] ??= []).push(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
    }),
    // Test helper — not part of the real Document API.
    fire(type: string) {
      (listeners[type] ?? []).forEach((l) => l());
    },
    listenerCount(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
}

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

describe("registerTasksLiveRefresh — owner tab freshness after server-side task mutations", () => {
  it("refetches when the tab becomes visible again", () => {
    const documentApi = makeFakeDocument("hidden");
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch });

    documentApi.visibilityState = "visible";
    documentApi.fire("visibilitychange");

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when the tab becomes hidden", () => {
    const documentApi = makeFakeDocument("visible");
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch });

    documentApi.visibilityState = "hidden";
    documentApi.fire("visibilitychange");

    expect(refetch).not.toHaveBeenCalled();
  });

  it("refetches when the service worker reports a push was received", () => {
    const documentApi = makeFakeDocument("visible");
    const serviceWorkerApi = makeFakeServiceWorker();
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi, refetch });

    serviceWorkerApi.fireMessage({ type: PUSH_RECEIVED_MESSAGE_TYPE });

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated service worker messages", () => {
    const documentApi = makeFakeDocument("visible");
    const serviceWorkerApi = makeFakeServiceWorker();
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi, refetch });

    serviceWorkerApi.fireMessage({ type: "some-other-message" });
    serviceWorkerApi.fireMessage(undefined);

    expect(refetch).not.toHaveBeenCalled();
  });

  it("works with no service worker available (e.g. unsupported browser) without throwing", () => {
    const documentApi = makeFakeDocument("hidden");
    const refetch = vi.fn();
    expect(() =>
      registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch }),
    ).not.toThrow();

    documentApi.visibilityState = "visible";
    documentApi.fire("visibilitychange");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("cleanup removes both listeners so a later event does not trigger a refetch", () => {
    const documentApi = makeFakeDocument("visible");
    const serviceWorkerApi = makeFakeServiceWorker();
    const refetch = vi.fn();

    const cleanup = registerTasksLiveRefresh({ documentApi, serviceWorkerApi, refetch });
    cleanup();

    documentApi.visibilityState = "hidden";
    documentApi.fire("visibilitychange");
    documentApi.visibilityState = "visible";
    documentApi.fire("visibilitychange");
    serviceWorkerApi.fireMessage({ type: PUSH_RECEIVED_MESSAGE_TYPE });

    expect(refetch).not.toHaveBeenCalled();
    expect(documentApi.listenerCount("visibilitychange")).toBe(0);
    expect(serviceWorkerApi.listenerCount()).toBe(0);
  });
});
