import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Inbox.tsx"), "utf-8");

/**
 * Production bug fix (2026-07-14): a note saved via Carson (voice or typed,
 * run from the bottom sheet on any route) must show up here without the user
 * having to navigate away and back. Carson's save_note tool dispatches
 * "ra7etbal:notes-changed" after a confirmed insert; this route reloads on
 * that signal.
 */
describe("Inbox.tsx — refreshes after Carson saves a note", () => {
  it("listens for the notes-changed event and reloads", () => {
    const start = SOURCE.indexOf("// Carson's save_note tool");
    expect(start).toBeGreaterThan(-1);
    const block = SOURCE.slice(start, start + 650);
    expect(block).toContain('window.addEventListener("ra7etbal:notes-changed", handleNotesChanged)');
    expect(block).toContain("void reload()");
    expect(block).toContain('window.removeEventListener("ra7etbal:notes-changed", handleNotesChanged)');
  });
});
