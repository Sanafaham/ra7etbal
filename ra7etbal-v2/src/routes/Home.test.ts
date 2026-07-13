import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Home.tsx"), "utf-8");

/**
 * Clear My Head (the capture textarea/photo-attach/submit flow on Home) was
 * removed from the product. Capture now always goes through Talk to
 * Carson / Type to Carson, which decide Note vs To-do themselves.
 */
describe("Home.tsx — Clear My Head removed", () => {
  it("no longer renders the Clear My Head section, textarea, or submit button", () => {
    expect(SOURCE).not.toContain("home-clear-my-head-section");
    expect(SOURCE).not.toContain("home-clear-my-head-textarea");
    expect(SOURCE).not.toContain("home-submit-button");
    expect(SOURCE).not.toContain("home-sticky-cta");
    expect(SOURCE).not.toContain("home-attach-button");
    expect(SOURCE).not.toContain("Clear My Head");
  });

  it("no longer imports the extraction pipeline or draft store", () => {
    expect(SOURCE).not.toContain("useExtractionStore");
    expect(SOURCE).not.toContain("useDraftStore");
    expect(SOURCE).not.toContain("describeImageForTextCarson");
  });

  it("still renders the greeting, stats grid, and Talk to Carson hero", () => {
    expect(SOURCE).toContain("home-greeting");
    expect(SOURCE).toContain("home-stats-grid");
    expect(SOURCE).toContain("home-talk-to-carson-button");
    expect(SOURCE).toContain("Talk to Carson");
  });
});
