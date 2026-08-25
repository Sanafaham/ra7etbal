import { describe, expect, it } from "vitest";
import { CARSON_STATUS_POLICY, CARSON_VOICE_SESSION_GUARD } from "./carson-status-policy";

// Defect-class detector (2026-08-25 production incident): a worked example
// combining a specific capitalized person-like name with a concrete
// assertion about them (a task, status, confirmation, or time) can be
// reproduced verbatim by the model as if it were a real, current fact — this
// is exactly how "You're waiting on Nasira to confirm the call request."
// reached a real production user with zero supporting data. This detector
// catches the CLASS of defect, not just that one sentence, so a future
// worked example added to this file without a bracketed placeholder fails
// CI instead of shipping silently.
const NAME_STOPLIST = new Set([
  "You", "Your", "Youre", "I", "Im", "Ill", "The", "Never", "Always", "One",
  "Two", "Three", "Not", "Do", "Dont", "Its", "Yes", "No", "Still", "Based",
  "According", "Nothing", "Everything", "Repeated", "Of", "Ask", "Please",
  "Ra7etBal", "Rahet", "Name", "Action", "Task", "Time", "Day", "Shall",
  "Should", "Would", "Do", "Does", "Take", "Whenever", "Are", "Let",
  "Bear", "Just", "Hold", "One", "Say", "Send", "Given", "Done", "Repeated",
]);

function findWorkedExamplesWithNamedPeople(promptText: string): string[] {
  const violations: string[] = [];
  const quoted = promptText.match(/"([^"]*)"/g) ?? [];
  const assertionMarker =
    /\b(AM|PM|confirm(ed|s)?|waiting on|hasn'?t|escalated|overdue|already|has everything|has it|today|now|handles|reliably|often|needs|working on|covered|handled|on it|done|finished)\b/i;

  for (const q of quoted) {
    if (!assertionMarker.test(q)) continue;
    const names = q.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
    for (const name of names) {
      const idx = q.indexOf(name);
      const bracketed = q[idx - 1] === "[" && q[idx + name.length] === "]";
      if (bracketed) continue;
      if (NAME_STOPLIST.has(name)) continue;
      violations.push(`${name} in: ${q}`);
    }
  }
  return violations;
}

describe("CARSON_STATUS_POLICY / CARSON_VOICE_SESSION_GUARD — no fact-like worked examples", () => {
  it("contains no quoted example combining a named person with a concrete task/status/confirmation/time assertion", () => {
    expect(findWorkedExamplesWithNamedPeople(CARSON_STATUS_POLICY)).toEqual([]);
  });

  it("CARSON_VOICE_SESSION_GUARD contains no such example either", () => {
    expect(findWorkedExamplesWithNamedPeople(CARSON_VOICE_SESSION_GUARD)).toEqual([]);
  });

  it("the detector allows bracketed structural placeholders like [Name]/[action]/[time]", () => {
    expect(
      findWorkedExamplesWithNamedPeople('"You are waiting on [Name] to confirm [action]."'),
    ).toEqual([]);
  });

  it("sanity check: the detector actually catches a known-bad literal example (no false negatives)", () => {
    expect(
      findWorkedExamplesWithNamedPeople('"You\'re waiting on Nasira to confirm the call request."'),
    ).not.toEqual([]);
    expect(
      findWorkedExamplesWithNamedPeople('"Two reminders today: call Ahmed at 9 AM and check the laundry at 10 AM."'),
    ).not.toEqual([]);
  });

  it("the exact 2026-08-25 fabricated-status sentence is gone and cannot silently return", () => {
    expect(CARSON_STATUS_POLICY).not.toContain("Nasira");
    expect(CARSON_STATUS_POLICY).not.toMatch(/waiting on Nasira/i);
    expect(CARSON_STATUS_POLICY).not.toContain("call request");
  });

  it("the Ahmed/laundry reminder example is genericized", () => {
    expect(CARSON_STATUS_POLICY).not.toContain("Ahmed");
    expect(CARSON_STATUS_POLICY).not.toContain("check the laundry at 10 AM");
  });

  it("the Grace worked examples are genericized", () => {
    expect(CARSON_STATUS_POLICY).not.toMatch(/already with Grace/i);
    expect(CARSON_STATUS_POLICY).not.toMatch(/Grace has everything/i);
    // Adversarial-review finding (2026-08-25): "Grace is working on it" in
    // the Rules block was the same defect class but used no word from the
    // original assertionMarker vocabulary ("working on" wasn't covered),
    // so it slipped past both the first genericization pass and the
    // detector itself. Locked here directly, and the detector's vocabulary
    // was broadened to include "working on"/"covered"/"handled"/"on it"/
    // "done"/"finished" so equivalent phrasing can't slip through again.
    expect(CARSON_STATUS_POLICY).not.toMatch(/Grace is working on it/i);
  });

  it("the Christopher worked examples are genericized, in both exported constants", () => {
    expect(CARSON_STATUS_POLICY).not.toMatch(/waiting on Christopher now/i);
    expect(CARSON_VOICE_SESSION_GUARD).not.toMatch(/Christopher has it/i);
    expect(CARSON_VOICE_SESSION_GUARD).not.toMatch(/sent Christopher the message/i);
  });

  it("preserves the legitimate trigger-phrase example (illustrates user input shape, not a Carson factual claim) — must not be over-deleted", () => {
    expect(CARSON_VOICE_SESSION_GUARD).toContain("Ask Christopher to make this for dinner");
  });
});

describe("Carson voice behavior policy", () => {
  it("tells Voice Carson to execute clear delegations without a second permission request", () => {
    expect(CARSON_STATUS_POLICY).toContain("Clear delegation instructions are enough permission to act");
    expect(CARSON_STATUS_POLICY).toContain("call the delegation tool immediately");
    expect(CARSON_STATUS_POLICY).toContain("Never ask \"shall I send this now\"");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("Ask Christopher to make this for dinner");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("execute immediately");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("Do not ask for permission again");
  });

  it("bans idle probing after completed actions", () => {
    expect(CARSON_STATUS_POLICY).toContain("Silence after completing an action is better");
    expect(CARSON_STATUS_POLICY).toContain("\"Are you still with me?\"");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("If the user is silent after you complete an action, remain silent and wait");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("Never ask \"shall I send this now\"");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("\"are you still with me\"");
  });
});
