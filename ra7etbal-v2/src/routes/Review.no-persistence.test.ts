import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Review.tsx"), "utf-8");

/**
 * Clear My Head product correction: Review.tsx (the Clear My Head review
 * screen) must never persist extracted items into Notes/To-dos/Reminders/
 * Delegations/Messages. Carson (ops-intelligence.ts / text-carson.ts) is the
 * only path allowed to call savePending(). These are source-scanning
 * regression guards — the strongest structural proof available without a
 * component-rendering harness (no React Testing Library in this project) —
 * that no code path to persistence exists in this file at all.
 */
describe("Review.tsx — Clear My Head never persists items (structural guard)", () => {
  it("does not import or call savePending", () => {
    expect(SOURCE).not.toMatch(/savePending/);
  });

  it("does not import or call saveTaskAttachments", () => {
    expect(SOURCE).not.toMatch(/saveTaskAttachments/);
  });

  it("does not import or call sendWhatsAppTask", () => {
    expect(SOURCE).not.toMatch(/sendWhatsAppTask/);
  });

  it("does not import or call sendDirectMessageRecord", () => {
    expect(SOURCE).not.toMatch(/sendDirectMessageRecord/);
  });

  it("does not import from lib/save, lib/whatsapp, or lib/direct-messages", () => {
    expect(SOURCE).not.toMatch(/from ["']..\/lib\/save["']/);
    expect(SOURCE).not.toMatch(/from ["']..\/lib\/whatsapp["']/);
    expect(SOURCE).not.toMatch(/from ["']..\/lib\/direct-messages["']/);
  });

  it("does not reference the tasks or messages stores (no local persistence side effects)", () => {
    expect(SOURCE).not.toMatch(/useTasksStore/);
    expect(SOURCE).not.toMatch(/useMessagesStore/);
  });

  it("still wires the per-item Remove control, so dumped items can be deleted", () => {
    expect(SOURCE).toMatch(/onRemove=\{removeItem\}/);
  });

  it("Discard all clears the extraction store (deleted items leave no trace)", () => {
    expect(SOURCE).toMatch(/function handleDiscardAll\(\)\s*\{[^}]*useExtractionStore\.getState\(\)\.clear\(\)/s);
  });

  it("Keep in Clear My Head does not clear the extraction store", () => {
    const match = SOURCE.match(/function handleKeep\(\)\s*\{([^}]*)\}/s);
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/useExtractionStore\.getState\(\)\.clear\(\)/);
  });
});
