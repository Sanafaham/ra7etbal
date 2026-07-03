import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

// Live production incident (2026-07-03): attaching 2 photos and delegating to
// Christopher produced two real, delivered WhatsApp sends 9 seconds apart —
// confirmed via Supabase tasks/messages/whatsapp_deliveries (both had a real
// meta_message_id and reached delivery_status "read"). Root cause: the
// send_delegation tool's cooldown lived only in that tool's closure and was
// never consulted by executeDelegationFromText, so a second attempt reaching
// Carson through the other path sent again — and an exact-text cooldown key
// would have missed it anyway, since the two turns' task text differed
// ("make these for dinner." vs "make these for dinner. I'll attach the
// photos."). This suite locks in the shared, fuzzy-matched guard that fixes it.
describe("ElevenLabsAgentWidget — cross-path duplicate delegation guard", () => {
  it("normalizes near-identical task text as the same delegation (fuzzy, not exact)", () => {
    const block = blockBetween(
      "function isSimilarDelegationTask(a: string, b: string): boolean {",
      "function normalizeMemoryText",
    );
    expect(block).toContain("const na = normalizeDelegationKey(a)");
    expect(block).toContain("const nb = normalizeDelegationKey(b)");
    expect(block).toContain("na === nb || na.startsWith(nb) || nb.startsWith(na)");
  });

  it("keeps one shared cooldown store for every delegation-send path, not a per-tool closure", () => {
    expect(SOURCE).toContain(
      "const recentDelegationsRef = useRef<Map<string, { taskText: string; at: number }[]>>(",
    );
    expect(SOURCE).toContain("const findRecentDuplicateDelegation = useCallback(");
    expect(SOURCE).toContain("const recordDelegationSent = useCallback((personName: string, taskText: string) => {");
  });

  it("send_delegation checks the shared guard before sending and records only after real success", () => {
    const cooldownBlock = blockBetween(
      "// 3. Cooldown. Fuzzy-matched by person + task",
      "const userId = authUserId;",
    );
    expect(cooldownBlock).toContain("if (findRecentDuplicateDelegation(person.name, taskText)) {");
    expect(cooldownBlock).toContain(
      "return `I already sent ${person.name} that delegation just now. Wait a moment before sending again.`",
    );
    // No exact-string-only cooldown key left behind — that was the bug.
    expect(SOURCE).not.toContain("const delegationKey = normalizeDelegationKey(taskText)");
    expect(SOURCE).not.toContain("const cooldownKey = `delegation:${normalizedName.toLowerCase()}:${delegationKey}`");

    const sendBlock = blockBetween(
      "Clear pending photos after successful send — covers the send_delegation path.",
      "sentDelegationsRef.current.push(",
    );
    // recordDelegationSent must run only after createAndSendDelegation
    // resolved without throwing — i.e. after a real, confirmed send.
    expect(sendBlock).toContain("recordDelegationSent(person.name, taskText)");
  });

  it("executeDelegationFromText is wired to the same guard, so a duplicate can't slip through the other path", () => {
    const callBlock = blockBetween(
      "const summary = await executeDelegationFromText",
      "onSavedExecution:",
    );
    expect(callBlock).toContain("isDuplicateDelegation: findRecentDuplicateDelegation");
    expect(callBlock).toContain("onDelegationSent: recordDelegationSent");
  });

  it("does not block distinct rapid delegations to the same person (e.g. dinner prep and kitchen check)", () => {
    // isSimilarDelegationTask only matches when one normalized string is a
    // prefix of the other — "prepare dinner" and "check the kitchen" share no
    // such relationship, so the legitimate multi-task-per-person case (called
    // out explicitly in the cooldown comment) keeps working.
    const block = blockBetween(
      "function isSimilarDelegationTask(a: string, b: string): boolean {",
      "function normalizeMemoryText",
    );
    // Strip the TS type annotations so this can run as plain JS via
    // `new Function` — the assertions above already prove this body matches
    // the real source text verbatim; this just exercises its actual logic.
    const stripped = block
      .replace("function isSimilarDelegationTask(a: string, b: string): boolean {", "return function (a, b) {")
      .replace(/: string/g, "");
    // eslint-disable-next-line no-new-func
    const isSimilarDelegationTask = new Function("normalizeDelegationKey", stripped)(
      (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    );

    expect(isSimilarDelegationTask("prepare dinner", "check the kitchen")).toBe(false);
    expect(isSimilarDelegationTask("make these for dinner.", "make these for dinner. I'll attach the photos.")).toBe(true);
    expect(isSimilarDelegationTask("make these for dinner.", "make these for dinner.")).toBe(true);
  });
});
