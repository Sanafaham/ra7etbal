/**
 * Voice bubble removal (owner decision 2026-10-09). Source-inspection tests,
 * matching this file family's convention (the widget is not unit-rendered in
 * this repo). The optional transcript view itself is render-tested in
 * src/components/carson/CarsonVoiceSessionTextRecord.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function between(start: string, end: string): string {
  const from = SOURCE.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = SOURCE.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return SOURCE.slice(from, to);
}

describe("no default voice bubbles", () => {
  it("the connected voice view renders only the avatar, the activity pill and the call controls — no conversation text", () => {
    const connected = between('{status === "connected" && channel === "voice" && (', '{status === "connected" && channel === "text" && (');
    expect(connected).toContain('aria-label="End call"');
    expect(connected).toContain('aria-live="polite"');
    for (const text of ["voiceConversation", "lastCarsonMessage", "lastUserTranscript", "CarsonVoiceSessionTextRecord"]) {
      expect(connected).not.toContain(text);
    }
    // The avatar is still rendered for the voice channel.
    expect(SOURCE).toContain("<CarsonVisualCore");
  });

  it("the transient 'Carson heard' notice and the always-on bubble stack are gone", () => {
    expect(SOURCE).not.toContain("Carson heard: “{lastUserTranscript}”");
    expect(SOURCE).not.toContain("voiceConversation.map(");
    expect(SOURCE).toContain("const [, setLastUserTranscript] = useState<string | null>(null);");
  });

  it("after a call, only the optional record is offered, hidden by default and reset for every new session", () => {
    expect(SOURCE).toContain("const [showVoiceTranscript, setShowVoiceTranscript] = useState(false);");
    const reset = between("setLastCarsonMessage(null);\n    setLastUserTranscript(null);", "if (userTranscriptTimerRef.current) {");
    expect(reset).toContain("setVoiceConversation([]);");
    expect(reset).toContain("setShowVoiceTranscript(false);");
    const gate = between('channel === "voice" &&\n        shouldShowCarsonVoiceTranscript({', "    </div>\n  );\n}\n\nfunction MicIcon");
    expect(gate).toContain("hasMessage: Boolean(lastCarsonMessage),");
    expect(gate).toContain("<CarsonVoiceSessionTextRecord");
    expect(gate).toContain("turns={voiceConversation}");
    expect(gate).toContain("shown={showVoiceTranscript}");
    expect(SOURCE.split("<CarsonVoiceSessionTextRecord").length - 1).toBe(1);
  });
});

describe("S2 amendment for legacy voice (owner decision 2026-10-09)", () => {
  it("the single presentation-boundary mark is skipped for voice and unchanged for typed", () => {
    expect((SOURCE.match(/markAttentionCapturesSurfaced\(/g) ?? []).length).toBe(1);
    const site = between("const presentedAttentionCaptureIds = resolvePresentedAttentionCaptureIds({", "markAttentionCapturesSurfaced(presentedAttentionCaptureIds);");
    expect(site).toContain(
      'if (requestedChannel !== "voice" && presentedAttentionCaptureIds.length > 0 && attentionGuardResultRef.current) {',
    );
  });

  it("opening the record cannot mark anything: the toggle only flips local display state", () => {
    expect(SOURCE).toContain("onToggle={() => setShowVoiceTranscript((shown) => !shown)}");
  });
});

describe("conversation integrity is unchanged", () => {
  it("transcript capture and its display sync are untouched (19 capture points, 2 sync points, as on Main)", () => {
    expect((SOURCE.match(/sessionTranscriptRef\.current\.push\(/g) ?? []).length).toBe(19);
    expect((SOURCE.match(/setVoiceConversation\(\[\.\.\.sessionTranscriptRef\.current\]\);/g) ?? []).length).toBe(2);
  });

  it("typed chat does not use any of the voice-only display state", () => {
    const typed = between('{status === "connected" && channel === "text" && (', '{channel === "voice" && isIosStandalonePwa');
    for (const voiceOnly of ["showVoiceTranscript", "CarsonVoiceSessionTextRecord", "voiceConversation"]) {
      expect(typed).not.toContain(voiceOnly);
    }
    expect(typed).toContain("<CarsonTypedChat");
  });
});
