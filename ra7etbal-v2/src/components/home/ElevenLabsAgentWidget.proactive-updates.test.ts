import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

describe("ElevenLabsAgentWidget — proactive Updates prompt guard", () => {
  it("does not present a proactive Updates prompt while Carson is already acting", () => {
    const guardBlockStart = SOURCE.indexOf("const presentProactiveUpdatePrompt = useCallback(");
    const guardBlockEnd = SOURCE.indexOf("const runLocalOutputProbe = useCallback(", guardBlockStart);
    const block = SOURCE.slice(guardBlockStart, guardBlockEnd);

    expect(block).toContain("toolInFlightRef.current");
    expect(block).toContain("typedSubmitInFlightRef.current");
    expect(block).toContain("typedAwaitingResponse");
    expect(block).toContain("Do not call any tool until the user chooses an action");
  });

  it("uses the same selector for voice and typed session start", () => {
    expect(SOURCE).toContain("void loadNextProactiveUpdate()");
    expect(SOURCE).toContain("presentProactiveUpdatePrompt(prompt, {");
    expect(SOURCE).toContain("channel: requestedChannel");
  });
});
