import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard — multi-recipient reroute for the single-recipient tools.
 *
 * Root cause: send_delegation and send_direct_whatsapp_message are simple,
 * single-recipient tools. The ElevenLabs LLM decides which tool to call and
 * how many times — for a compound instruction naming more than one person
 * ("Tell Grace X and Christopher Y"), it can call one of these tools once
 * per person it "remembers," silently dropping a later-named person with no
 * error, warning, or diagnostic surfaced. Each call it does make reports its
 * own outcome truthfully, but nothing previously checked whether the number
 * of tool calls matched the number of people actually named in the turn.
 *
 * This mirrors the existing guest/hosting guardrail (which already
 * intercepts send_delegation and reroutes to the deterministic operational
 * plan engine), generalized to any instruction naming 2+ known people:
 * both tools now check the verbatim transcript via
 * countKnownRecipientsMentioned before sending, and reroute to
 * execute_instruction (executeDelegationFromText) when it finds more than
 * one — the already-existing multi-recipient-safe path (deterministic
 * parseMultiRecipientDelegation / Sonnet extraction, Promise.allSettled
 * sends, truthful per-recipient summary). This file only locks in that the
 * guard is wired into the two tool handlers in the expected shape and
 * ordering — it does not re-test executeDelegationFromText's own send/report
 * logic, which is unmodified and out of scope.
 */
const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

describe("ElevenLabsAgentWidget — multi-recipient reroute guard", () => {
  it("imports countKnownRecipientsMentioned from the multi-recipient-delegation module", () => {
    expect(SOURCE).toContain('import { countKnownRecipientsMentioned } from "../../lib/multi-recipient-delegation";');
  });

  it("sendDelegation checks countKnownRecipientsMentioned and reroutes through executeInstructionRef when 2+ known people are named", () => {
    expect(SOURCE).toMatch(
      /const mentionedRecipients = countKnownRecipientsMentioned\(latestUserMessageForOps, people\);\s*\n\s*if \(mentionedRecipients\.length >= 2\) \{\s*\n\s*const result =\s*\n\s*\(await executeInstructionRef\.current\?\.\(\{ instruction: latestUserMessageForOps \}\)\) \?\?/,
    );
  });

  it("sendDelegation returns immediately after the reroute (single execution, no fallthrough to single-recipient send)", () => {
    const guardBlock = SOURCE.match(
      /if \(mentionedRecipients\.length >= 2\) \{[\s\S]{0,600}?\n {8}\}\n {6}\}/,
    )?.[0];
    expect(guardBlock).toBeTruthy();
    expect(guardBlock).toMatch(/return result;/);
    // Only one return statement inside the guard body — confirms no code path
    // falls through to send a second time after rerouting.
    expect(guardBlock?.match(/return /g)?.length).toBe(1);
  });

  it("executeInstructionRef is kept in sync with the real executeInstruction callback every render", () => {
    expect(SOURCE).toContain("const executeInstructionRef = useRef<");
    expect(SOURCE).toContain("executeInstructionRef.current = executeInstruction;");
  });

  it("sendDelegation's multi-recipient guard runs after the guest/hosting guardrail, not before (hosting keeps priority)", () => {
    const hostingIdx = SOURCE.indexOf("const guestAction = resolveGuestOutcomeAction(latestUserMessageForOps);");
    const multiRecipientIdx = SOURCE.indexOf("Guardrail: an instruction naming more than one known person must\n      // never execute as a single-recipient delegation");
    expect(hostingIdx).toBeGreaterThan(-1);
    expect(multiRecipientIdx).toBeGreaterThan(-1);
    expect(multiRecipientIdx).toBeGreaterThan(hostingIdx);
  });

  it("send_direct_whatsapp_message checks countKnownRecipientsMentioned and reroutes through executeInstructionRef when 2+ known people are named", () => {
    expect(SOURCE).toMatch(
      /const mentionedRecipients = countKnownRecipientsMentioned\(\s*\n\s*latestUserMessageForOps,\s*\n\s*usePeopleStore\.getState\(\)\.items,\s*\n\s*\);\s*\n\s*if \(mentionedRecipients\.length >= 2\) \{\s*\n\s*const result =\s*\n\s*\(await executeInstructionRef\.current\?\.\(\{ instruction: latestUserMessageForOps \}\)\) \?\?/,
    );
  });

  it("send_direct_whatsapp_message's multi-recipient guard runs before the unsafe-message-body redirect", () => {
    const guardIdx = SOURCE.indexOf("Guardrail: an instruction naming more than one known person must\n      // never execute as a single-recipient direct message");
    const unsafeBodyIdx = SOURCE.indexOf("if (isUnsafeDirectMessageBody(text)) {");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(unsafeBodyIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(unsafeBodyIdx);
  });

  it("neither guarded tool's dependency array references executeInstruction directly (accessed only via the stable ref, avoiding a used-before-declaration error)", () => {
    expect(SOURCE).toMatch(
      /\[\s*\n\s*displayName,\s*\n\s*maybeSendImpliedDinnerDelegation,\s*\n\s*clearPendingImages,\s*\n\s*findRecentDuplicateDelegation,\s*\n\s*recordDelegationSent,\s*\n\s*\],\s*\n\s*\);/,
    );
    expect(SOURCE).toContain("[sendDelegation],");
  });

  it("the guest/hosting guardrail block is unmodified — still blocks send_delegation, still calls the deterministic operational plan engine", () => {
    expect(SOURCE).toMatch(/const guestAction = resolveGuestOutcomeAction\(latestUserMessageForOps\);/);
    expect(SOURCE).toMatch(/const hostingGate = evaluateHostingPlanningGate\(latestUserMessageForOps\);/);
    expect(SOURCE).toMatch(/const plan = await buildOperationalPlanFromOutcome\(latestUserMessageForOps, people\);/);
  });

  it("a single-recipient delegation still falls through to the original, unmodified single-person resolution", () => {
    // The pre-existing single-recipient path (name matching against `people`)
    // is still reachable directly after the new guard — countKnownRecipientsMentioned
    // returns exactly 1 for an ordinary single-person instruction (see
    // multi-recipient-delegation.test.ts), so `mentionedRecipients.length >= 2`
    // is false and execution proceeds to this unchanged code.
    expect(SOURCE).toMatch(
      /const matches = people\.filter\(\s*\n\s*\(p\) => p\.name\.trim\(\)\.toLowerCase\(\) === normalizedName\.toLowerCase\(\),\s*\n\s*\);/,
    );
  });

  it("a single-recipient direct message still falls through to the original, unmodified person resolution and send", () => {
    expect(SOURCE).toMatch(
      /const people = usePeopleStore\.getState\(\)\.items;\s*\n\s*const person = people\.find\(\s*\n\s*\(p\) => p\.name\.trim\(\)\.toLowerCase\(\) === name\.toLowerCase\(\),\s*\n\s*\);/,
    );
    expect(SOURCE).toContain('return `WhatsApp accepted the message to ${person.name}. I\'ll watch for delivery updates.`;');
  });

  it("protected: executeDelegationFromText's truthful per-recipient summary (sent/failed/unsent, by name) is unmodified — the rerouted path's authoritative reporting logic was not touched by this change", () => {
    const textCarsonSource = readFileSync(
      join(__dirname, "..", "..", "lib", "text-carson.ts"),
      "utf-8",
    );
    // Success line, by name.
    expect(textCarsonSource).toMatch(/\$\{names\} \$\{sentWhatsAppNames\.length === 1 \? "has" : "have"\} it/);
    // Explicit per-recipient failure line — the mechanism that lets a mixed
    // success/failure instruction report each outcome truthfully instead of
    // one blanket success/failure for the whole turn.
    expect(textCarsonSource).toContain("`${recipient} was NOT messaged — ${reason}`");
    expect(textCarsonSource).toContain(
      "Explicit failure report so Voice Carson must acknowledge send failures",
    );
  });
});
