import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(__dirname, "manifest.webmanifest"), "utf8"));
const index = readFileSync(join(ROOT, "index.html"), "utf8");
const icon = readFileSync(join(__dirname, "icons/ra7etbal-icon.svg"), "utf8");
const maskableIcon = readFileSync(join(__dirname, "icons/ra7etbal-icon-maskable.svg"), "utf8");

describe("PWA visual identity", () => {
  it("uses the approved dark, gold, and white system in browser metadata", () => {
    expect(manifest.background_color).toBe("#151310");
    expect(manifest.theme_color).toBe("#151310");
    expect(index).toContain('<meta name="theme-color" content="#151310" />');
    expect(index).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
  });

  it("keeps the manifest and Apple touch icon wired to the canonical assets", () => {
    expect(new Set(manifest.icons.map(({ src }) => src))).toEqual(new Set([
      "/icons/ra7etbal-icon.svg",
      "/icons/ra7etbal-icon-192.png",
      "/icons/ra7etbal-icon-512.png",
      "/icons/ra7etbal-icon-maskable.svg",
    ]));
    expect(index).toContain('<link rel="apple-touch-icon" href="/icons/ra7etbal-icon-180.png" />');

    for (const filename of ["ra7etbal-icon-180.png", "ra7etbal-icon-192.png", "ra7etbal-icon-512.png"]) {
      expect(statSync(join(__dirname, "icons", filename)).size).toBeGreaterThan(0);
    }
  });

  it("serves the owner-supplied raster lockup without generated SVG geometry", () => {
    for (const source of [icon, maskableIcon]) {
      expect(source).toContain("Ra7etbal · راحة بال");
      expect(source).toContain('href="data:image/png;base64,');
      expect(source).not.toContain("OWNER_SUPPLIED_LOCKUP_DATA");
      expect(source).not.toContain("<path");
    }
  });
});
