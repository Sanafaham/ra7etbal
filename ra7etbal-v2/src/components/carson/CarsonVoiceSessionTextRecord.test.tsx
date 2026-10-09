/**
 * Voice bubble removal (owner decision 2026-10-09): the optional, hidden-by-
 * default session text record shown after a voice call. Pure view, rendered
 * with renderToStaticMarkup (same convention as TaskOnlyDecisionView.test.tsx).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import CarsonVoiceSessionTextRecord, {
  VOICE_SESSION_TEXT_RECORD_ID,
  VOICE_SESSION_TEXT_RECORD_NOTE,
} from "./CarsonVoiceSessionTextRecord";
import type { TranscriptMessage } from "../../lib/carson-summarize";

const TURNS: TranscriptMessage[] = [
  { role: "user", message: "What needs my attention?" },
  { role: "agent", message: "Overdue reminders (2): Renew the parking permit; Water the plants." },
];

const render = (turns: TranscriptMessage[], shown: boolean) =>
  renderToStaticMarkup(<CarsonVoiceSessionTextRecord turns={turns} shown={shown} onToggle={() => {}} />);

describe("CarsonVoiceSessionTextRecord", () => {
  it("is hidden by default: only a collapsed 'Show transcript' control, no conversation text", () => {
    const html = render(TURNS, false);
    expect(html).toContain(">Show transcript<");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-controls="${VOICE_SESSION_TEXT_RECORD_ID}"`);
    expect(html).not.toContain("<section");
    expect(html).not.toContain("What needs my attention?");
    expect(html).not.toContain("Renew the parking permit");
  });

  it("when requested, shows every turn in order inside a labelled region the control points to", () => {
    const html = render(TURNS, true);
    expect(html).toContain(">Hide transcript<");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`<section id="${VOICE_SESSION_TEXT_RECORD_ID}" aria-label="Session text record"`);
    expect(html.indexOf("What needs my attention?")).toBeGreaterThan(-1);
    expect(html.indexOf("What needs my attention?")).toBeLessThan(html.indexOf("Renew the parking permit"));
  });

  it("is labelled as a session text record that may differ from speech, never as an audio transcript", () => {
    const html = render(TURNS, true);
    expect(html).toContain(VOICE_SESSION_TEXT_RECORD_NOTE.replace("'", "&#x27;"));
    expect(VOICE_SESSION_TEXT_RECORD_NOTE).toMatch(/may have differed/);
    expect(html.toLowerCase()).not.toContain("audio transcript");
  });

  it("renders nothing when the call has no turns", () => {
    expect(render([], false)).toBe("");
    expect(render([], true)).toBe("");
  });

  it("is a pure view: it cannot mark captures surfaced or write anything", () => {
    const source = readFileSync(join(__dirname, "CarsonVoiceSessionTextRecord.tsx"), "utf8");
    for (const forbidden of ["markAttentionCapturesSurfaced", "markCarsonNotesSurfaced", "markCarsonTodosSurfaced", "supabase", "fetch("]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toMatch(/^import type \{ TranscriptMessage \}/m);
  });
});
