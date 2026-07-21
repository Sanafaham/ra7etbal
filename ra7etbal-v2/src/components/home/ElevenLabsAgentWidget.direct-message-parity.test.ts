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

describe("ElevenLabsAgentWidget — typed-only direct-message owner normalization", () => {
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

  it("voice's own send_direct_whatsapp_message tool composes and sends its message text without any normalization step", () => {
    const voiceToolBlock = blockBetween(
      "// Client tool: send_direct_whatsapp_message",
      "// Client tool: save_city",
    );

    expect(voiceToolBlock).toContain("createAndSendDirectMessage({");
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
