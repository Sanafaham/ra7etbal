/**
 * 2026-09-01 owner canary — multi-segment agent_message truncation.
 *
 * ElevenLabs can deliver one logical Carson turn as more than one "agent"
 * onMessage event — carson-transcript-turn-state.ts's own header comment
 * already documents this for tool-invoking turns. Before this fix, each
 * event unconditionally overwrote lastCarsonMessage, so only the LAST
 * segment stayed visible even though the full multi-part answer was
 * actually spoken (reproduced live: an attention-summary answer covering
 * overdue reminders, a delegation, and a calendar item displayed as only
 * its final sentence). Source-inspection tests, matching this file's
 * existing convention (see ElevenLabsAgentWidget.sdk-config.test.ts) since
 * the component is not unit-rendered anywhere in this repo.
 */
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

describe("multi-segment agent_message accumulation", () => {
  const mergeBlock = () =>
    blockBetween(
      "const wasAlreadyDisplayedThisTurn = carsonTranscriptTurnStateRef.current",
      "setLastCarsonMessage(mergedDisplayMessage);",
    );

  it("checks carsonTranscriptTurnStateRef BEFORE reducing, so it reflects whether a segment already displayed for THIS turn", () => {
    const block = mergeBlock();
    const checkIndex = block.indexOf('carsonTranscriptTurnStateRef.current === "displayed"');
    const reduceIndex = block.indexOf("reduceCarsonTranscriptTurn(");
    expect(checkIndex).toBeGreaterThan(-1);
    expect(reduceIndex).toBeGreaterThan(checkIndex);
  });

  it("only merges when the previous transcript entry is also an agent segment — never merges across a user turn boundary", () => {
    const block = mergeBlock();
    expect(block).toContain('previousSegment?.role === "agent"');
  });

  it("merges via a single splice replacing both entries with one combined entry, not two separate array entries", () => {
    const block = mergeBlock();
    expect(block).toContain("sessionTranscriptRef.current.splice(sessionTranscriptRef.current.length - 2, 2,");
    expect(block).toContain("message: mergedDisplayMessage");
  });

  it("the visible bubble is set from the merged text, not the latest segment alone", () => {
    expect(SOURCE).toContain("setLastCarsonMessage(mergedDisplayMessage);");
    // The old unconditional overwrite must be gone from this exact call site.
    expect(SOURCE).not.toContain("setLastCarsonMessage(finalDisplayMessage);\n\n            if (requestedChannel");
  });

  it("a first segment of a genuinely new turn is unaffected — mergedDisplayMessage defaults to finalDisplayMessage when there is no prior segment this turn", () => {
    const block = mergeBlock();
    expect(block).toMatch(/let mergedDisplayMessage = finalDisplayMessage;/);
  });

  it("carsonTranscriptTurnStateRef only resets to \"pending\" on a genuine new user turn, not on every agent message", () => {
    // Line ~6701 area: the "user" role branch resets it; the agent branch
    // (this fix's block) never assigns "pending" directly.
    const agentBlock = blockBetween(
      '} else if (role === "agent") {',
      "setLastCarsonMessage(mergedDisplayMessage);",
    );
    expect(agentBlock).not.toContain('carsonTranscriptTurnStateRef.current = "pending"');
  });
});
