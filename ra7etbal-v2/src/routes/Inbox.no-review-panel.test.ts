import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Inbox.tsx"), "utf-8");

/**
 * The "Needs Processing" panel (InboxReviewPanel, backed by inbox_items —
 * captured via the now-removed Clear My Head / Text Carson capture path)
 * was removed. This route is pure Notes now: search, add, and per-note
 * Remind Me / Delegate / Make Task / Add to Calendar / Delete actions.
 */
describe("Inbox.tsx — Notes only, no capture-review panel", () => {
  it("no longer imports or renders InboxReviewPanel", () => {
    expect(SOURCE).not.toContain("InboxReviewPanel");
    expect(SOURCE).not.toContain("onPrefill");
  });

  it("no longer depends on the removed draft store", () => {
    expect(SOURCE).not.toContain("useDraftStore");
  });

  it("still renders the Notes search and add-a-note affordances", () => {
    expect(SOURCE).toContain("Search notes");
    expect(SOURCE).toContain("Add a note");
    expect(SOURCE).toContain("saveCarsonNote");
  });
});
