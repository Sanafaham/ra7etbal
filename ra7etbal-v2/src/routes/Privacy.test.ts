import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Privacy.tsx"), "utf-8");
const APP_SOURCE = readFileSync(join(__dirname, "..", "App.tsx"), "utf-8");

/**
 * Google OAuth verification (2026-07-11) requires a public-facing Limited
 * Use disclosure for Google Workspace/Calendar data. Source-scanning guard
 * so the exact required sentence, and the existing legal sections around
 * it, can't be silently dropped by a later edit.
 */
describe("Privacy.tsx — Google API Services User Data Policy disclosure", () => {
  it("contains the exact required Limited Use disclosure sentence", () => {
    expect(SOURCE).toMatch(
      /The use and transfer of information received from Google APIs by Ra7etBal will adhere\s*to the/,
    );
    expect(SOURCE).toMatch(/Google API Services User Data Policy/);
    expect(SOURCE).toMatch(/including the Limited Use requirements/);
  });

  it("links to Google's actual policy page, not a placeholder", () => {
    expect(SOURCE).toContain("https://developers.google.com/terms/api-services-user-data-policy");
  });

  it("is its own numbered section, adjacent to the existing Google Calendar section", () => {
    expect(SOURCE).toMatch(/3\. Google Calendar/);
    expect(SOURCE).toMatch(/4\. Google API Services User Data Policy/);
  });

  it("keeps every pre-existing section, correctly renumbered after inserting the new one", () => {
    expect(SOURCE).toMatch(/1\. About Ra7etBal/);
    expect(SOURCE).toMatch(/2\. What We Collect/);
    expect(SOURCE).toMatch(/5\. How We Use Your Data/);
    expect(SOURCE).toMatch(/6\. We Do Not Sell Your Data/);
    expect(SOURCE).toMatch(/7\. Data Storage and Security/);
    expect(SOURCE).toMatch(/8\. Data Deletion/);
    expect(SOURCE).toMatch(/9\. Third-Party Services/);
    expect(SOURCE).toMatch(/10\. Contact/);
  });

  it("does not alter existing legal text — Do Not Sell / Data Deletion / Contact sections are unchanged", () => {
    expect(SOURCE).toContain(
      "We do not sell, rent, or share your personal data with any third party for commercial",
    );
    expect(SOURCE).toContain("We will delete your data within 30 days of your request.");
    expect(SOURCE).toContain("For any privacy questions or data requests, contact us at");
  });

  it("the /privacy route is registered and public (no ProtectedRoute wrapper)", () => {
    expect(APP_SOURCE).toMatch(/<Route path="\/privacy" element=\{<Privacy \/>\} \/>/);
  });
});
