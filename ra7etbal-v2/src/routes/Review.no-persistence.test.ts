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

  it("'Leave here for now' does not clear the extraction store", () => {
    const match = SOURCE.match(/function handleKeep\(\)\s*\{([^}]*)\}/s);
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/useExtractionStore\.getState\(\)\.clear\(\)/);
  });
});

/**
 * Wording + label cleanup: Clear My Head must read as a temporary,
 * non-operational space. The "keep" button must never say anything that
 * implies real persistence, and item badges must never show a bare real
 * Carson object-type name (see ItemCard.tsx / reviewDisplayLabel).
 */
describe("Review.tsx — copy does not imply permanent saving", () => {
  it("does not use the old 'Keep in Clear My Head' button copy", () => {
    expect(SOURCE).not.toMatch(/Keep in Clear My Head/);
  });

  it("the keep button's visible copy avoids persistence-implying language", () => {
    const buttonMatch = SOURCE.match(/onClick=\{handleKeep\}[\s\S]*?<\/button>/);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch![0]).not.toMatch(/\b(save|saved|keep|kept|store|stored)\b/i);
  });
});

const ITEM_CARD_SOURCE = readFileSync(
  join(__dirname, "..", "components", "review", "ItemCard.tsx"),
  "utf-8",
);

describe("ItemCard.tsx — Clear My Head badges do not display real Carson object labels", () => {
  it("does not render a bare 'To-do' badge label", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/label:\s*"To-?do"/i);
  });

  it("no longer keeps a per-type 'label' field at all — the badge text comes from reviewDisplayLabel", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/label:\s*"/);
  });

  it("renders the badge text via reviewDisplayLabel(item.type), not a raw type label", () => {
    expect(ITEM_CARD_SOURCE).toMatch(/\{reviewDisplayLabel\(item\.type\)\}/);
  });
});

/**
 * Display cleanup: Clear My Head Review cards must not show Carson
 * operational fields (Assign To, Message to send, Due date, confirmation
 * link copy, delegation/message controls, Attach photo) — showing them made
 * a temporary, unsaved thought look like Carson had already acted on it.
 * Only the badge, item text, and Remove control remain. Carson conversion
 * still happens entirely outside this screen (ops-intelligence.ts /
 * text-carson.ts), untouched.
 */
describe("ItemCard.tsx — no Carson operational fields on Clear My Head cards", () => {
  it("does not render an Assign To control", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/Assign to/i);
    expect(ITEM_CARD_SOURCE).not.toMatch(/onAssign/);
  });

  it("does not render a Message to send control", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/Message to send/i);
    expect(ITEM_CARD_SOURCE).not.toMatch(/onMessageChange/);
  });

  it("does not render a Due date", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/\bDue:/);
    expect(ITEM_CARD_SOURCE).not.toMatch(/dueAt|dueText/);
  });

  it("does not render confirmation-link copy", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/Confirmation link/i);
  });

  it("does not render an Attach photo control", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/Attach photo/i);
    expect(ITEM_CARD_SOURCE).not.toMatch(/onImageChange/);
    expect(ITEM_CARD_SOURCE).not.toMatch(/type="file"/);
  });

  it("does not take a people list (no assignment UI needs it)", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/\bpeople\b/);
  });

  it("still renders the item's plain text and the Remove control", () => {
    expect(ITEM_CARD_SOURCE).toMatch(/onDescriptionChange/);
    expect(ITEM_CARD_SOURCE).toMatch(/onClick=\{\(\) => onRemove\(item\.id\)\}/);
  });
});

describe("Review.tsx — no Carson operational field wiring left to pass down", () => {
  it("does not wire onAssign, onMessageChange, or onImageChange to ItemCard", () => {
    expect(SOURCE).not.toMatch(/onAssign=/);
    expect(SOURCE).not.toMatch(/onMessageChange=/);
    expect(SOURCE).not.toMatch(/onImageChange=/);
  });

  it("still tells the user to ask Carson to convert items later", () => {
    expect(SOURCE).toMatch(/ask Carson to turn/i);
  });
});
