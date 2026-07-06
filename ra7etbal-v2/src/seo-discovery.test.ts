import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const sitemap = readFileSync(resolve(root, "public/sitemap.xml"), "utf8");
const robots = readFileSync(resolve(root, "public/robots.txt"), "utf8");
const vercelConfig = readFileSync(resolve(root, "vercel.json"), "utf8");
const indexHtml = readFileSync(resolve(root, "index.html"), "utf8");
const canonicalOrigin = "https://www.ra7etbal.com";

function sitemapUrls() {
  return Array.from(sitemap.matchAll(/<loc>(.*?)<\/loc>/g), (match) => match[1]);
}

describe("SEO discovery", () => {
  it("exposes only public crawlable pages in the sitemap", () => {
    expect(sitemapUrls()).toEqual([
      `${canonicalOrigin}/`,
      `${canonicalOrigin}/privacy`,
      `${canonicalOrigin}/terms`,
    ]);

    expect(sitemap).not.toMatch(/\/(?:auth|reset|review|updates|active|inbox|actions|follow-ups|messages|notes|people|history|routines|confirm|debug)\b/);
  });

  it("points robots.txt at the canonical sitemap", () => {
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain(`Sitemap: ${canonicalOrigin}/sitemap.xml`);
  });

  it("keeps SEO files out of the SPA fallback rewrite", () => {
    expect(vercelConfig).toContain("robots\\\\.txt$");
    expect(vercelConfig).toContain("sitemap\\\\.xml$");
  });

  it("declares the production redirect target as canonical", () => {
    expect(indexHtml).toContain(`<link rel="canonical" href="${canonicalOrigin}/" />`);
  });

  it("does not define duplicate app-level domain redirects", () => {
    const parsed = JSON.parse(vercelConfig) as { redirects?: unknown };
    expect(parsed.redirects).toBeUndefined();
  });
});
