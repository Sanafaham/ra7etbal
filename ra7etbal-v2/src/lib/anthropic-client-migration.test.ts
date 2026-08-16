import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /api/anthropic now requires authentication (see api/anthropic.js and
 * api/anthropic.test.js). Every legitimate browser caller must go through
 * the shared callAnthropicProxy() helper (src/lib/anthropic-client.ts),
 * which is the only place a Supabase session token is attached. This test
 * proves every known caller was migrated and none regresses to a raw,
 * unauthenticated fetch("/api/anthropic", ...) call.
 */
const CALLERS = [
  { path: "text-carson.ts", relativeToLib: "." },
  { path: "ai/extract.ts", relativeToLib: "." },
  { path: "ai/compose-message.ts", relativeToLib: "." },
  { path: "carson-summarize.ts", relativeToLib: "." },
  { path: "carson-fact-extract.ts", relativeToLib: "." },
  { path: "weekly-planning.ts", relativeToLib: "." },
  { path: "ops-intelligence.ts", relativeToLib: "." },
  { path: "people-behavior.ts", relativeToLib: "." },
];

const LIB_DIR = join(__dirname);
const WIDGET_PATH = join(__dirname, "..", "components", "home", "ElevenLabsAgentWidget.tsx");

describe("api/anthropic callers — all migrated to the authenticated helper", () => {
  for (const caller of CALLERS) {
    it(`${caller.path} uses callAnthropicProxy, not a raw fetch to /api/anthropic`, () => {
      const source = readFileSync(join(LIB_DIR, caller.path), "utf-8");
      expect(source).toMatch(/callAnthropicProxy/);
      expect(source).not.toMatch(/fetch\(\s*["']\/api\/anthropic["']/);
    });
  }

  it("ElevenLabsAgentWidget.tsx uses callAnthropicProxy, not a raw fetch to /api/anthropic", () => {
    const source = readFileSync(WIDGET_PATH, "utf-8");
    expect(source).toMatch(/callAnthropicProxy/);
    expect(source).not.toMatch(/fetch\(\s*["']\/api\/anthropic["']/);
  });

  it("the shared helper itself is the only place a raw fetch to /api/anthropic exists", () => {
    const helperSource = readFileSync(join(LIB_DIR, "anthropic-client.ts"), "utf-8");
    expect(helperSource).toMatch(/fetch\(\s*["']\/api\/anthropic["']/);
    expect(helperSource).toMatch(/Authorization/);
  });
});
