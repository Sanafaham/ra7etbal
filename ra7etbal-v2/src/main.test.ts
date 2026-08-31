/**
 * Structural regression guard for the C-03 live-gate blank-page defect
 * (see src/lib/supabase.test.ts for the underlying config-error logic).
 * Source-inspection test, matching the convention already used for
 * vercel.json routing in api/carson-custom-llm-orchestration.test.js.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("main.tsx startup diagnostic wiring", () => {
  it("checks supabaseConfigError before rendering the app, instead of importing supabase.ts unconditionally", () => {
    const source = fs.readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/supabaseConfigError/);
    // A visible fallback must exist for the misconfigured-env branch — not
    // an empty #root left for the browser to show as a blank page.
    expect(source).toMatch(/renderStartupDiagnostic|replaceChildren/);
  });
});
