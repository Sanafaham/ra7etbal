import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Home.tsx"), "utf-8");

/**
 * The home card entry point into Carson was renamed from "Talk to Carson" /
 * "Ready when you are." to "Tell Carson" / "Carson will handle it." as part
 * of the Carson channel menu (WhatsApp/Call Carson alongside Talk now/Type).
 */
describe("Home.tsx — Tell Carson card copy", () => {
  it("shows the new headline and supporting copy", () => {
    expect(SOURCE).toContain("Tell Carson");
    expect(SOURCE).toContain("Carson will handle it.");
  });

  it("no longer shows the old headline text on the card", () => {
    const cardBlock = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-talk-to-carson-button"'),
      SOURCE.indexOf('data-testid="home-talk-to-carson-button"') + 700,
    );
    expect(cardBlock).not.toContain("Talk to Carson");
    expect(cardBlock).not.toContain("Ready when you are.");
  });

  it("still opens the Carson sheet via the same store setter", () => {
    const cardBlock = SOURCE.slice(
      SOURCE.indexOf('data-testid="home-talk-to-carson-button"') - 50,
      SOURCE.indexOf('data-testid="home-talk-to-carson-button"') + 200,
    );
    expect(cardBlock).toContain("onClick={() => openCarson(true)}");
  });
});
