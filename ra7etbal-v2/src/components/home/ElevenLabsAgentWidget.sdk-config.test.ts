import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

const PACKAGE_JSON = JSON.parse(
  readFileSync(join(__dirname, "../../..", "package.json"), "utf-8"),
) as {
  dependencies?: Record<string, string>;
};

const PACKAGE_LOCK = JSON.parse(
  readFileSync(join(__dirname, "../../..", "package-lock.json"), "utf-8"),
) as {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

function countOccurrences(needle: string): number {
  return SOURCE.split(needle).length - 1;
}

describe("ElevenLabsAgentWidget — SDK config compatibility", () => {
  it("uses the upgraded stable React SDK path that brings the newer client audio stack", () => {
    expect(PACKAGE_JSON.dependencies?.["@elevenlabs/react"]).toBe("^1.9.0");
    expect(PACKAGE_LOCK.packages?.["node_modules/@elevenlabs/react"]?.version).toBe("1.9.0");
    expect(PACKAGE_LOCK.packages?.["node_modules/@elevenlabs/client"]?.version).toBe("1.14.0");
    expect(PACKAGE_LOCK.packages?.["node_modules/@elevenlabs/types"]?.version).toBe("0.16.0");
    expect(PACKAGE_LOCK.packages?.["node_modules/webrtc-adapter"]?.version).toBe("9.0.6");
  });

  it("opens one public Conversation.startSession path with the iOS audio-route settle config", () => {
    expect(countOccurrences("Conversation.startSession(")).toBe(1);

    const optionsBlock = blockBetween(
      "const conv = await Conversation.startSession({",
      "clientTools: {",
    );
    expect(optionsBlock).toContain("agentId,");
    expect(optionsBlock).toContain("connectionDelay: { default: 0, android: 3_000, ios: 500 }");
    expect(optionsBlock).toContain("dynamicVariables: {");
    expect(optionsBlock).toContain("ra7etbal_state:");
    expect(optionsBlock).toContain("daily_brief:");
    expect(optionsBlock).toContain("opening_line:");
    expect(optionsBlock).toContain("current_time:");
    expect(optionsBlock).toContain("persistent_instructions:");
    expect(optionsBlock).not.toContain("agent: {");
    expect(optionsBlock).not.toContain("prompt");
    expect(optionsBlock).not.toContain("overrides");
    expect(optionsBlock).not.toContain("connectionType");
  });

  it("keeps one guarded endSession path and no fallback audio/session implementation", () => {
    expect(countOccurrences(".endSession()")).toBe(1);
    expect(SOURCE).toContain("const endConversationSession = useCallback(");
    expect(SOURCE).toContain("teardownInFlightRef.current = true;");
    expect(SOURCE).toContain("const micWarmupPromise: Promise<MediaStream | null> =");
    expect(SOURCE).not.toContain("new WebSocket(");
    expect(SOURCE).not.toContain("new RTCPeerConnection(");
    expect(SOURCE).not.toContain("getDisplayMedia(");
  });

  it("registers transcript and lifecycle callbacks on the single SDK session", () => {
    const sessionBlock = blockBetween(
      "const conv = await Conversation.startSession({",
      "      });\n      // The SDK owns its own mic stream from here",
    );
    expect(sessionBlock).toContain("onMessage:");
    expect(sessionBlock).toContain("onDisconnect:");
    expect(sessionBlock).toContain("onError:");
    expect(sessionBlock).toContain("onConnect:");
    expect(sessionBlock).toContain("onUnhandledClientToolCall:");
  });
});
