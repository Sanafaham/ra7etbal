import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARSON_LIVE_INFORMATION_POLICY } from "../../lib/carson-status-policy";

const source = readFileSync(
  new URL("./ElevenLabsAgentWidget.tsx", import.meta.url),
  "utf8",
);

describe("ElevenLabs Carson live information capability", () => {
  it("registers one read-only provider-neutral client capability", () => {
    expect(source).toContain("retrieve_live_information: async");
    expect(source).toContain("retrieveLiveInformationTool(params)");
    expect(source).not.toContain("retrieve_anthropic_information");
    expect(source).not.toContain("retrieve_openai_information");
  });

  it("keeps the retrieval tool available in typed advisory mode", () => {
    const blockedStart = source.indexOf("const TYPED_BLOCKED_TOOL_MESSAGES");
    const blockedEnd = source.indexOf("};", blockedStart);
    const blockedTools = source.slice(blockedStart, blockedEnd);

    expect(blockedTools).not.toContain("retrieve_live_information");
  });

  it("runs live retrieval through Carson's standard tool diagnostics and acting state", () => {
    const registration = source.slice(
      source.indexOf("retrieve_live_information: async"),
      source.indexOf("save_city:", source.indexOf("retrieve_live_information: async")),
    );
    expect(registration).toContain('runDirectToolWithDiagnostic(');
    expect(registration).toContain('"retrieve_live_information"');
  });

  it("injects the same live-information policy into voice and typed sessions", () => {
    const start = source.indexOf("const channelInstructions =");
    const end = source.indexOf("// The warm-up", start);
    const block = source.slice(start, end);

    expect(block.match(/CARSON_LIVE_INFORMATION_POLICY/g)).toHaveLength(2);
  });

  it("requires live retrieval before current answers and truthful failure reporting", () => {
    expect(CARSON_LIVE_INFORMATION_POLICY).toContain(
      "call retrieve_live_information before answering",
    );
    expect(CARSON_LIVE_INFORMATION_POLICY).toContain(
      "Never answer a live-information request from memory",
    );
    expect(CARSON_LIVE_INFORMATION_POLICY).toContain(
      "Never say you do not know or refuse merely because the information is current",
    );
    expect(CARSON_LIVE_INFORMATION_POLICY).toContain("LIVE_LOOKUP_FAILED");
    expect(CARSON_LIVE_INFORMATION_POLICY).toContain("LIVE_LOOKUP_NOT_REQUIRED");
    expect(CARSON_LIVE_INFORMATION_POLICY).toContain(
      "Never invent live facts, retrieval results, or sources",
    );
  });
});
