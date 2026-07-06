import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const sitemap = readFileSync(resolve(root, "public/sitemap.xml"), "utf8");
const robots = readFileSync(resolve(root, "public/robots.txt"), "utf8");
const vercelConfig = readFileSync(resolve(root, "vercel.json"), "utf8");
const indexHtml = readFileSync(resolve(root, "index.html"), "utf8");

function sitemapUrls() {
  return Array.from(sitemap.matchAll(/<loc>(.*?)<\/loc>/g), (match) => match[1]);
}

describe("SEO discovery", () => {
  it("exposes only public crawlable pages in the sitemap", () => {
    expect(sitemapUrls()).toEqual([
      "https://ra7etbal.com/",
      "https://ra7etbal.com/privacy",
      "https://ra7etbal.com/terms",
    ]);

    expect(sitemap).not.toMatch(/\/(?:auth|reset|review|updates|active|inbox|actions|follow-ups|messages|notes|people|history|routines|confirm|debug)\b/);
  });

  it("points robots.txt at the canonical sitemap", () => {
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Sitemap: https://ra7etbal.com/sitemap.xml");
  });

  it("keeps SEO files out of the SPA fallback rewrite", () => {
    expect(vercelConfig).toContain("robots\\\\.txt$");
    expect(vercelConfig).toContain("sitemap\\\\.xml$");
  });

  it("declares the apex domain as canonical", () => {
    expect(indexHtml).toContain('<link rel="canonical" href="https://ra7etbal.com/" />');
  });
});
