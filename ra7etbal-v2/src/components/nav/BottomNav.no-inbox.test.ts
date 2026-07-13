import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NAV_SOURCE = readFileSync(join(__dirname, "BottomNav.tsx"), "utf-8");
const APP_SOURCE = readFileSync(join(__dirname, "../../App.tsx"), "utf-8");

/**
 * Clear My Head and the internal Inbox surface were removed from the
 * product. Bottom nav stays 4 items (Home / Updates / People / Carson) and
 * no longer tracks an inbox badge counter. Removed routes redirect instead
 * of exposing a broken screen.
 */
describe("BottomNav — no Clear My Head / Inbox surface", () => {
  it("no longer imports or uses the inbox badge store", () => {
    expect(NAV_SOURCE).not.toContain("useBadgeStore");
    expect(NAV_SOURCE).not.toContain("inboxCount");
  });

  it("still has exactly 4 nav destinations: Home, Updates, People, Carson", () => {
    expect(NAV_SOURCE).toContain('aria-label="Home"');
    expect(NAV_SOURCE).toContain('aria-label="Updates"');
    expect(NAV_SOURCE).toContain('aria-label="People"');
    expect(NAV_SOURCE).toContain('aria-label="Talk to Carson"');
    expect(NAV_SOURCE).not.toContain("Clear My Head");
    expect(NAV_SOURCE).not.toContain(">Inbox<");
  });

  it("Updates badge priority no longer falls through to an inbox count", () => {
    const badgeBlock = NAV_SOURCE.slice(
      NAV_SOURCE.indexOf("const updatesBadge = useMemo("),
      NAV_SOURCE.indexOf("}, [tasks]);"),
    );
    expect(badgeBlock).toContain("brief.needsAttention.length");
    expect(badgeBlock).toContain("brief.waitingOnOthers.length");
    expect(badgeBlock).not.toContain("inboxCount");
  });
});

describe("App.tsx — removed routes redirect instead of rendering a broken screen", () => {
  it("no longer imports the removed Review route/component", () => {
    expect(APP_SOURCE).not.toContain('import Review from "./routes/Review"');
  });

  it("/review redirects to Home instead of rendering a missing component", () => {
    expect(APP_SOURCE).toMatch(/<Route path="\/review" element=\{<Navigate to="\/" replace \/>\} \/>/);
  });
});
