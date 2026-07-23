import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "App.tsx"), "utf-8");

/**
 * The Carson sheet's idle supporting sentence was replaced with the channel
 * question, ahead of the Talk now / Type / WhatsApp / Call Carson row that
 * lives inside ElevenLabsAgentWidget's own idle view.
 */
describe("App.tsx — Carson sheet copy", () => {
  it("replaces the old supporting sentence with the channel question", () => {
    expect(SOURCE).toContain("How would you like to reach Carson?");
    expect(SOURCE).not.toContain("Ask about your tasks, delegate to someone, or set a reminder.");
  });

  it("keeps the sheet header unchanged", () => {
    expect(SOURCE).toContain('<p className="text-sm font-semibold text-ink">Carson</p>');
    expect(SOURCE).toContain('<p className="text-[11px] text-ink/45">Your Chief of Staff</p>');
  });
});
