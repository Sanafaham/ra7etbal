import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

// NOTE: this file's original title and the "voice ... without any
// normalization step" test below asserted that Talk to Carson's outgoing
// direct messages were never normalized — that assumption was proven wrong
// by a confirmed production regression ("Ask Grace to call me now." sent
// Grace the literal text "call me now"). Normalization is now guaranteed
// for every direct-message path, Talk and Type alike, at the shared
// createAndSendDirectMessage / createDirectMessageRecord boundary in
// direct-messages.ts — see the "Owner-reference normalization at the shared
// direct-message delivery boundary" suite in carson-protected-behaviors.test.ts
// for the actual behavioral proof. The two source-text checks these two
// call sites still opt into (normalizeOwnerReference) remain true and
// unchanged — they're just no longer the only place normalization happens.
describe("ElevenLabsAgentWidget — direct-message owner normalization call sites", () => {
  it("gates normalizeOwnerReference to the typed channel at the model-driven executeDirectMessageFastPath call site", () => {
    const callBlock = blockBetween(
      "const directMessageFastPath =",
      "if (directMessageFastPath.handled) {",
    );

    expect(callBlock).toContain("executeDirectMessageFastPath(rawInstruction,");
    expect(callBlock).toContain('normalizeOwnerReference: activeChannelRef.current === "text"');
  });

  it("also opts in at the deterministic typed dispatch call site — that path only ever runs for the typed channel, so it hardcodes true instead of the channel check", () => {
    const callBlock = blockBetween(
      "const typedDirectMessageFastPath = await executeDirectMessageFastPath(",
      "if (typedDirectMessageFastPath.handled) {",
    );

    expect(callBlock).toContain("normalizeOwnerReference: true");
  });

  it("normalizeOwnerReference is opted into from exactly these two call sites — the shared executor is never opted into normalization from anywhere else", () => {
    const occurrences = SOURCE.match(/normalizeOwnerReference:/g) ?? [];
    expect(occurrences).toHaveLength(2);
  });

  it("voice's own send_direct_whatsapp_message tool does not duplicate normalization logic itself — it delegates to the shared createAndSendDirectMessage boundary, which now normalizes for every caller", () => {
    const voiceToolBlock = blockBetween(
      "// Client tool: send_direct_whatsapp_message",
      "// Client tool: save_city",
    );

    expect(voiceToolBlock).toContain("createAndSendDirectMessage({");
    // This widget file never opts in or calls the normalizer directly for
    // this tool — correct, because createAndSendDirectMessage itself now
    // normalizes unconditionally (see direct-messages.ts). A local opt-in
    // flag here would be redundant, not additionally protective.
    expect(voiceToolBlock).not.toContain("normalizeOwnerReference");
    expect(voiceToolBlock).not.toContain("normalizeFirstPersonForOwner");
    expect(voiceToolBlock).not.toContain("executeDirectMessageFastPath");
  });

  it("does not duplicate the normalization utility import or logic anywhere else in the component", () => {
    const importOccurrences = SOURCE.match(/from "\.\.\/\.\.\/lib\/direct-message-owner-normalization"/g) ?? [];
    // The component itself never imports the normalizer directly — it lives
    // solely inside direct-message-fast-path.ts, called once from there.
    expect(importOccurrences).toHaveLength(0);
    expect(SOURCE).not.toContain("normalizeFirstPersonForOwner");
  });
});
