import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "BottomNav.tsx"), "utf-8");

/** The bottom nav Carson tab label was renamed to "Tell Carson". */
describe("BottomNav.tsx — Tell Carson label", () => {
  it("shows the new label", () => {
    expect(SOURCE).toContain("<span>Tell Carson</span>");
  });

  it("still opens the Carson sheet via the same store setter", () => {
    const buttonBlock = SOURCE.slice(
      SOURCE.indexOf("Carson — active when sheet open"),
      SOURCE.indexOf("<span>Tell Carson</span>"),
    );
    expect(buttonBlock).toContain("onClick={() => setCarsonOpen(true)}");
  });
});
