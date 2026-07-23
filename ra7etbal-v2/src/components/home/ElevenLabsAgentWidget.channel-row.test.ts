import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

/**
 * The idle-state channel row gained WhatsApp / Call Carson entries next to
 * the existing Talk now (was "Talk to Carson") and Type (was "Type to
 * Carson") buttons. This must not touch startCall / startTypedSession or
 * any other session logic — only the row's labels and two new sibling
 * links, gated on lib/carson-channels so a missing destination never
 * renders a dead-end button.
 */
describe("ElevenLabsAgentWidget.tsx — Carson channel row", () => {
  it("keeps Talk now wired to the original startCall handler", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf("Talk now button"),
      SOURCE.indexOf("Type button"),
    );
    expect(block).toContain("onClick={startCall}");
    expect(block).toContain('aria-label="Talk now"');
    expect(block).toContain(">\n              Talk now\n");
  });

  it("keeps Type wired to the original startTypedSession handler", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf("Type button"),
      SOURCE.indexOf("WhatsApp — only when"),
    );
    expect(block).toContain("onClick={startTypedSession}");
    expect(block).toContain('aria-label="Type"');
    expect(block).toContain(">Type<");
  });

  it("gates WhatsApp and Call Carson on their configured destination", () => {
    expect(SOURCE).toContain("{carsonWhatsAppUrl && (");
    expect(SOURCE).toContain("{carsonCallUrl && (");
  });

  it("opens WhatsApp externally with the configured link, never hardcoded", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf("{carsonWhatsAppUrl && ("),
      SOURCE.indexOf(">WhatsApp<"),
    );
    expect(block).toContain("href={carsonWhatsAppUrl}");
    expect(block).toContain('target="_blank"');
    expect(block).toContain('rel="noopener noreferrer"');
  });

  it("dials Call Carson with a tel: link from the configured destination", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf("{carsonCallUrl && ("),
      SOURCE.indexOf(">Call Carson<"),
    );
    expect(block).toContain("href={carsonCallUrl}");
  });

  it("imports the channel destinations from the isolated carson-channels helper", () => {
    expect(SOURCE).toContain(
      'import { getCarsonCallUrl, getCarsonWhatsAppUrl } from "../../lib/carson-channels";',
    );
  });
});
