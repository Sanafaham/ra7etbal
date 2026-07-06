import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

const DIAGNOSTICS_SOURCE = readFileSync(
  join(__dirname, "../../lib/carson-diagnostics.ts"),
  "utf-8",
);

function countOccurrences(needle: string): number {
  return SOURCE.split(needle).length - 1;
}

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — iPhone PWA audio diagnostics", () => {
  it("keeps audio diagnostics opt-in through query/localStorage, not always visible", () => {
    expect(SOURCE).toContain('params.get("carson_audio_diag")');
    expect(SOURCE).toContain('const [audioDiagnosticsEnabled, setAudioDiagnosticsEnabled] = useState(');
    expect(SOURCE).toContain("{audioDiagnosticsEnabled && (");
    expect(SOURCE).toContain("Speaker test");
    expect(SOURCE).toContain("Mic loopback");
    expect(SOURCE).toContain("Copy packet");
  });

  it("labels iPhone Home Screen PWA voice as beta while Regression 1 remains open", () => {
    expect(SOURCE).toContain("const isIosStandalonePwa =");
    expect(SOURCE).toContain("iPhone PWA voice beta: audio quality under investigation.");
  });

  it("records environment, local probe, and session events in the existing diagnostics buffer", () => {
    expect(DIAGNOSTICS_SOURCE).toContain('"carson-audio-environment"');
    expect(DIAGNOSTICS_SOURCE).toContain('"carson-audio-probe"');
    expect(DIAGNOSTICS_SOURCE).toContain('"carson-audio-session"');
    expect(SOURCE).toContain('recordCarsonDiagnostic("carson-audio-environment"');
    expect(SOURCE).toContain('recordCarsonDiagnostic("carson-audio-probe"');
    expect(SOURCE).toContain('recordCarsonDiagnostic("carson-audio-session"');
  });

  it("diagnoses audio without introducing a second ElevenLabs or WebRTC session path", () => {
    expect(countOccurrences("Conversation.startSession(")).toBe(1);
    expect(countOccurrences(".endSession()")).toBe(1);
    expect(SOURCE).not.toContain("new RTCPeerConnection(");
    expect(SOURCE).not.toContain("new WebSocket(");
  });

  it("copies a support packet with the versions and commits already tried", () => {
    const copyBlock = blockBetween(
      "const copyAudioDiagnosticsPacket = useCallback(async () => {",
      "const maybeSendImpliedDinnerDelegation = useCallback(",
    );
    expect(copyBlock).toContain('productionUrl: "https://www.ra7etbal.com"');
    expect(copyBlock).toContain('"@elevenlabs/react": "1.9.0"');
    expect(copyBlock).toContain('"@elevenlabs/client": "1.14.0"');
    expect(copyBlock).toContain('"9562d65 teardown guard"');
    expect(copyBlock).toContain('"1e02bd7 iOS mic warm-up and connection delay"');
    expect(copyBlock).toContain('"18711586 ElevenLabs SDK upgrade"');
    expect(copyBlock).toContain('"1b4223f invalid transcript guard"');
    expect(copyBlock).toContain("getCarsonDiagnostics()");
  });
});
