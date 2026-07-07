import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NAV_SOURCE = readFileSync(join(__dirname, "BottomNav.tsx"), "utf-8");
const APP_SOURCE = readFileSync(join(__dirname, "../../App.tsx"), "utf-8");

describe("BottomNav mobile safe-area layout", () => {
  it("keeps the bottom nav fixed to the viewport bottom and respects the iOS/PWA safe area", () => {
    expect(NAV_SOURCE).toContain("fixed bottom-0 inset-x-0");
    expect(NAV_SOURCE).toContain('paddingBottom: "max(env(safe-area-inset-bottom), 8px)"');
  });

  it("reserves enough bottom padding so Updates cards and actions do not sit under the nav", () => {
    expect(APP_SOURCE).toContain('paddingBottom: "calc(env(safe-area-inset-bottom) + 112px)"');
    expect(APP_SOURCE).toContain("{showNav && <BottomNav />}");
  });
});
