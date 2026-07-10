import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("registerTasksLiveRefresh — safety-net poll (Bug #2: stale client state)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls every pollIntervalMs while the tab is visible at registration", async () => {
    const documentApi = makeFakeDocument("visible");
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch, pollIntervalMs: 1000 });

    expect(refetch).not.toHaveBeenCalled(); // no immediate refetch just from registering
    await vi.advanceTimersByTimeAsync(1000);
    expect(refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("does not poll while the tab starts hidden", () => {
    const documentApi = makeFakeDocument("hidden");
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch, pollIntervalMs: 1000 });

    vi.advanceTimersByTime(5000);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("pauses polling when the tab becomes hidden", () => {
    const documentApi = makeFakeDocument("visible");
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch, pollIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    expect(refetch).toHaveBeenCalledTimes(1);

    documentApi.visibilityState = "hidden";
    documentApi.fire("visibilitychange");
    refetch.mockClear();

    vi.advanceTimersByTime(5000);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("refreshes immediately and resumes polling when the tab becomes visible again", async () => {
    const documentApi = makeFakeDocument("hidden");
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch, pollIntervalMs: 1000 });

    documentApi.visibilityState = "visible";
    documentApi.fire("visibilitychange");
    await Promise.resolve(); // let the immediate safeRefetch's in-flight guard clear
    expect(refetch).toHaveBeenCalledTimes(1); // immediate refresh on regaining visibility

    await vi.advanceTimersByTimeAsync(1000);
    expect(refetch).toHaveBeenCalledTimes(2); // polling resumed
  });

  it("cleanup stops the poll timer", () => {
    const documentApi = makeFakeDocument("visible");
    const refetch = vi.fn();
    const cleanup = registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch, pollIntervalMs: 1000 });

    cleanup();
    vi.advanceTimersByTime(10_000);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("prevents overlapping refresh requests — a slow in-flight refetch blocks the next trigger until it resolves", async () => {
    const documentApi = makeFakeDocument("visible");
    let resolveFirst: () => void = () => {};
    const refetch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch, pollIntervalMs: 1000 });

    vi.advanceTimersByTime(1000); // first poll tick starts a slow refetch
    expect(refetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000); // second tick fires while the first is still in flight
    expect(refetch).toHaveBeenCalledTimes(1); // skipped, not queued or stacked

    resolveFirst();
    await Promise.resolve(); // let the .finally() microtask run
    await Promise.resolve();

    vi.advanceTimersByTime(1000); // now a fresh tick is allowed through
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("default poll interval is 60 seconds when not overridden", () => {
    const documentApi = makeFakeDocument("visible");
    const refetch = vi.fn();
    registerTasksLiveRefresh({ documentApi, serviceWorkerApi: null, refetch });

    vi.advanceTimersByTime(59_000);
    expect(refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
