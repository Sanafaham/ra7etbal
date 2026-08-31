/**
 * Regression coverage for the C-03 live-gate blank-page defect: a deployment
 * missing VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY (e.g. the isolated
 * carson-stage2a-boundary-proof project) must never crash the whole module
 * graph at import time — main.tsx relies on `supabaseConfigError` staying a
 * plain exported value (never a throw) to show a visible diagnostic instead
 * of a blank white page. See main.test.ts for the main.tsx wiring check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("supabaseConfigError", () => {
  it("is set with the exact missing env var names, and the module does not throw", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    vi.resetModules();

    const { supabaseConfigError } = await import("./supabase");
    expect(supabaseConfigError).toContain("VITE_SUPABASE_URL");
    expect(supabaseConfigError).toContain("VITE_SUPABASE_ANON_KEY");
  });

  it("still produces a usable client when config is missing, so session.ts's synchronous onAuthStateChange call at import time never crashes", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    vi.resetModules();

    const { supabase } = await import("./supabase");
    expect(typeof supabase.auth.onAuthStateChange).toBe("function");
  });

  it("is null when both env vars are present", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
    vi.resetModules();

    const { supabaseConfigError } = await import("./supabase");
    expect(supabaseConfigError).toBeNull();
  });
});
