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

const ELEVENLABS_BASE_CONNECTION_TYPES = readFileSync(
  join(__dirname, "../../..", "node_modules/@elevenlabs/client/dist/utils/BaseConnection.d.ts"),
  "utf-8",
);

const ELEVENLABS_CONNECTION_FACTORY = readFileSync(
  join(__dirname, "../../..", "node_modules/@elevenlabs/client/dist/utils/ConnectionFactory.js"),
  "utf-8",
);

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

  it("opens one public Conversation.startSession path on the SDK default public voice connection", () => {
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
    expect(optionsBlock).not.toContain("output_format");
    expect(optionsBlock).not.toContain("outputFormat");
    expect(optionsBlock).not.toContain("connectionType");
    expect(optionsBlock).not.toContain("sampleRate");
    expect(optionsBlock).not.toContain("format:");
  });

  it("documents why websocket/pcm_16000 is not forced in the browser PWA client", () => {
    expect(ELEVENLABS_BASE_CONNECTION_TYPES).toContain("connectionType?: ConnectionType");
    expect(ELEVENLABS_BASE_CONNECTION_TYPES).toContain('format: "pcm" | "ulaw"');
    expect(ELEVENLABS_BASE_CONNECTION_TYPES).toContain("sampleRate: number");
    expect(ELEVENLABS_CONNECTION_FACTORY).toContain("if (config.connectionType)");
    expect(ELEVENLABS_CONNECTION_FACTORY).toContain('return config.textOnly ? "websocket" : "webrtc"');
    expect(SOURCE).toContain("The WebSocket plus 16 kHz PCM experiment prevented Carson from");
    expect(SOURCE).toContain("connecting in the iPhone Home Screen PWA");
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
    expect(sessionBlock).toContain("onConversationMetadata:");
    expect(sessionBlock).toContain("agentOutputAudioFormat");
    expect(sessionBlock).toContain("userInputAudioFormat");
    expect(sessionBlock).toContain("onUnhandledClientToolCall:");
  });

  it("records a safe diagnostic packet when startSession fails before SDK callbacks fire", () => {
    const catchBlock = blockBetween(
      "} catch (err) {",
      "      // Show the real error message so the user knows what went wrong.",
    );
    expect(catchBlock).toContain('console.error("[carson-start-session-failed]"');
    expect(catchBlock).toContain('recordCarsonDiagnostic("carson-error"');
    expect(catchBlock).toContain('kind: "start_session_failed"');
    expect(catchBlock).toContain('recordCarsonDiagnostic("carson-audio-session"');
    expect(catchBlock).toContain('phase: "start_session_failed"');
    expect(catchBlock).toContain("getCarsonAudioEnvironment()");
  });
});
