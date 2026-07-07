import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Review.tsx"), "utf-8");
const ITEM_CARD_SOURCE = readFileSync(
  join(__dirname, "..", "components", "review", "ItemCard.tsx"),
  "utf-8",
);
const HOME_SOURCE = readFileSync(join(__dirname, "Home.tsx"), "utf-8");

describe("Review.tsx — Clear My Head canonical save path", () => {
  it("uses savePending as the only object-creation boundary", () => {
    expect(SOURCE).toMatch(/import \{ savePending, saveTaskAttachments \} from ["']\.\.\/lib\/save["']/);
    expect(SOURCE).toMatch(/const result = await savePending\(/);
    expect(SOURCE).not.toMatch(/createReminderTask|createDelegationTaskAndMessage|createTodo\(|saveCarsonNote\(/);
  });

  it("keeps image attachments on the savePending path", () => {
    expect(SOURCE).toMatch(/const imageFiles = new Map<string, File>\(\)/);
    expect(SOURCE).toMatch(/if \(item\.imageFile\) imageFiles\.set\(item\.id, item\.imageFile\)/);
    expect(SOURCE).toMatch(/saveTaskAttachments/);
  });

  it("keeps WhatsApp sending behind the saved message result, not a parallel route", () => {
    expect(SOURCE).toMatch(/const savedMessages = result\.messages\.filter/);
    expect(SOURCE).toMatch(/sendWhatsAppTask\(\{/);
    expect(SOURCE).toMatch(/sendDirectMessageRecord\(\{/);
    expect(SOURCE).not.toMatch(/sendWhatsAppTask\([\s\S]*itemsToSave/);
  });

  it("reloads canonical Tasks and Messages stores after saving", () => {
    expect(SOURCE).toMatch(/useTasksStore\.getState\(\)\.loadFor\(userId, \{ force: true \}\)/);
    expect(SOURCE).toMatch(/useMessagesStore\.getState\(\)\.loadFor\(userId, \{ force: true \}\)/);
  });
});

describe("Review.tsx — inbox fallback remains separate", () => {
  const handleKeepSource = SOURCE.slice(
    SOURCE.indexOf("async function handleKeep"),
    SOURCE.indexOf("function handleDiscardAll"),
  );
  const handleSaveSource = SOURCE.slice(
    SOURCE.indexOf("async function handleSave"),
    SOURCE.indexOf("async function handleKeep"),
  );
  const handleDiscardAllSource = SOURCE.slice(SOURCE.indexOf("function handleDiscardAll"));

  it("imports saveClearMyHeadInboxItems only for Leave here for now", () => {
    expect(SOURCE).toMatch(/from ["']\.\.\/lib\/clear-my-head-inbox["']/);
    expect(handleKeepSource).toMatch(/await saveClearMyHeadInboxItems\(items\.map\(\(it\) => it\.description\)\)/);
    expect(handleSaveSource).not.toMatch(/saveClearMyHeadInboxItems/);
  });

  it("handleKeep clears stores only after the inbox save succeeds", () => {
    const saveIndex = handleKeepSource.indexOf("saveClearMyHeadInboxItems");
    const clearIndex = handleKeepSource.indexOf("useExtractionStore.getState().clear()");
    expect(saveIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(saveIndex);
  });

  it("failure states surface errors without clearing the review", () => {
    expect(handleKeepSource).toMatch(/catch \(err\)/);
    expect(handleKeepSource).toMatch(/setSaveError\(/);
    expect(handleSaveSource).toMatch(/catch \(err\)/);
    expect(handleSaveSource).toMatch(/setSaveError\(/);
  });

  it("Discard all never saves objects or inbox rows", () => {
    expect(handleDiscardAllSource).not.toMatch(/savePending|saveClearMyHeadInboxItems|sendWhatsAppTask|sendDirectMessageRecord/);
    expect(handleDiscardAllSource).toMatch(/useExtractionStore\.getState\(\)\.clear\(\)/);
  });
});

describe("ItemCard.tsx — restored review controls without duplicate implementation", () => {
  it("renders review controls that feed the extraction store", () => {
    expect(ITEM_CARD_SOURCE).toMatch(/onAssign/);
    expect(ITEM_CARD_SOURCE).toMatch(/onMessageChange/);
    expect(ITEM_CARD_SOURCE).toMatch(/onImageChange/);
    expect(ITEM_CARD_SOURCE).toMatch(/onRemove/);
  });

  it("does not create records directly from the card", () => {
    expect(ITEM_CARD_SOURCE).not.toMatch(/savePending|createTask|createTodo|saveCarsonNote|sendWhatsAppTask/);
  });

  it("keeps Clear My Head badge display labels separate from object creation", () => {
    expect(ITEM_CARD_SOURCE).toMatch(/\{reviewDisplayLabel\(item\.type\)\}/);
    expect(ITEM_CARD_SOURCE).not.toMatch(/label:\s*"/);
  });
});

describe("Home.tsx — Clear My Head UI and Carson handoff guards", () => {
  it("has one normal Clear My Head submit button and one keyboard-only sticky CTA", () => {
    expect(HOME_SOURCE.match(/data-testid="home-submit-button"/g) ?? []).toHaveLength(1);
    expect(HOME_SOURCE.match(/data-testid="home-sticky-cta-button"/g) ?? []).toHaveLength(1);
    expect(HOME_SOURCE).toMatch(/\{keyboardOpen && \(/);
  });

  it("hands question-style advanced requests away from capture before extraction", () => {
    const questionIndex = HOME_SOURCE.indexOf("if (looksLikeQuestion(trimmed))");
    const openIndex = HOME_SOURCE.indexOf("openCarson(true)", questionIndex);
    const extractionIndex = HOME_SOURCE.indexOf("await runExtraction");
    expect(questionIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(questionIndex);
    expect(extractionIndex).toBeGreaterThan(questionIndex);
    expect(HOME_SOURCE).toMatch(/Carson can answer questions/);
  });
});
