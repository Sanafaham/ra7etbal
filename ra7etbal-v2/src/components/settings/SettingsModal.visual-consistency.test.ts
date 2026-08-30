import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "SettingsModal.tsx"), "utf8");

describe("SettingsModal dark-system readability", () => {
  it("uses readable shared text tokens for calendar and notification helper actions", () => {
    expect(SOURCE).toContain('const statusClass = isRevoked ? "text-danger" : "text-text-soft"');
    expect(SOURCE).toContain("Connect to let Carson read and manage your Google Calendar.");
    expect(SOURCE).toContain("Install Ra7etBal to enable notifications on your iPhone or iPad.");
    expect(SOURCE).toContain("text-[11px] text-text-soft underline");
    expect(SOURCE).toContain("text-[11px] leading-snug text-text-muted");
  });

  it("keeps legal rows on the primary readable ActionRow contract", () => {
    expect(SOURCE).toContain('<ActionRow label="Privacy Policy"');
    expect(SOURCE).toContain('<ActionRow label="Terms of Service"');
    expect(SOURCE).toContain('<span className="text-base text-ink">{label}</span>');
  });
});
