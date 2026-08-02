import { afterEach, describe, expect, it, vi } from "vitest";
import { isIOSDevice, isStandaloneDisplayMode, needsIOSInstallGuidance } from "./pwa-standalone";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const DESKTOP_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function stubUserAgent(ua: string) {
  vi.stubGlobal("navigator", {
    ...navigator,
    userAgent: ua,
  });
}

function stubIPadOS() {
  // iPadOS 13+ identifies as "MacIntel" but exposes touch points a real Mac never has.
  vi.stubGlobal("navigator", {
    ...navigator,
    userAgent: DESKTOP_MAC_UA,
    platform: "MacIntel",
    maxTouchPoints: 5,
  });
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({ matches, media: query })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isIOSDevice", () => {
  it("recognizes an iPhone user agent", () => {
    stubUserAgent(IPHONE_UA);
    expect(isIOSDevice()).toBe(true);
  });

  it("recognizes iPadOS 13+ reporting as MacIntel with touch support", () => {
    stubIPadOS();
    expect(isIOSDevice()).toBe(true);
  });

  it("does not misclassify a real Mac (MacIntel, no touch points) as iOS", () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent: DESKTOP_MAC_UA,
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(isIOSDevice()).toBe(false);
  });

  it("does not misclassify Android as iOS", () => {
    stubUserAgent(ANDROID_UA);
    expect(isIOSDevice()).toBe(false);
  });
});

describe("isStandaloneDisplayMode", () => {
  it("is true when navigator.standalone is set (iOS Safari installed app)", () => {
    vi.stubGlobal("navigator", { ...navigator, standalone: true });
    stubMatchMedia(false);
    expect(isStandaloneDisplayMode()).toBe(true);
  });

  it("is true when the display-mode: standalone media query matches", () => {
    vi.stubGlobal("navigator", { ...navigator, standalone: false });
    stubMatchMedia(true);
    expect(isStandaloneDisplayMode()).toBe(true);
  });

  it("is false in an ordinary browser tab", () => {
    vi.stubGlobal("navigator", { ...navigator, standalone: false });
    stubMatchMedia(false);
    expect(isStandaloneDisplayMode()).toBe(false);
  });
});

describe("needsIOSInstallGuidance", () => {
  it("is true on iOS Safari in a regular browser tab", () => {
    stubUserAgent(IPHONE_UA);
    vi.stubGlobal("navigator", { ...navigator, userAgent: IPHONE_UA, standalone: false });
    stubMatchMedia(false);
    expect(needsIOSInstallGuidance()).toBe(true);
  });

  it("is false on iOS once running as the installed standalone app", () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: IPHONE_UA, standalone: true });
    stubMatchMedia(false);
    expect(needsIOSInstallGuidance()).toBe(false);
  });

  it("is false on Android, even in a regular browser tab (push works there without install)", () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: ANDROID_UA, standalone: false });
    stubMatchMedia(false);
    expect(needsIOSInstallGuidance()).toBe(false);
  });

  it("is false on desktop", () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: DESKTOP_MAC_UA, platform: "MacIntel", maxTouchPoints: 0, standalone: false });
    stubMatchMedia(false);
    expect(needsIOSInstallGuidance()).toBe(false);
  });
});
