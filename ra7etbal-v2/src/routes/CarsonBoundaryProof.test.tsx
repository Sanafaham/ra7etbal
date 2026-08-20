import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => ({ supabase: {} }));
vi.mock("../hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@elevenlabs/react", () => ({ Conversation: { startSession: vi.fn() } }));

import { readFileSync } from "node:fs";
import { isCarsonBoundaryProofPath, STAGE2A_OPENING_LINE } from "./CarsonBoundaryProof";

describe("Stage 2A route isolation", () => {
  it("selects only the exact non-production proof path", () => {
    expect(isCarsonBoundaryProofPath("/non-production/carson-boundary-proof")).toBe(true);
    expect(isCarsonBoundaryProofPath("/")).toBe(false);
    expect(isCarsonBoundaryProofPath("/non-production/carson-boundary-proof/extra")).toBe(false);
  });
});

describe("Stage 2A session initialization contract", () => {
  // Regression guard: the cloned non-production agent's first message is
  // "{{opening_line}}". Starting a session without that dynamic variable makes
  // ElevenLabs reject initialization (close 1008, agent_configuration_error)
  // before the Custom LLM is ever invoked — the proof can never run.
  const source = readFileSync(new URL("./CarsonBoundaryProof.tsx", import.meta.url), "utf8");

  it("supplies opening_line as a dynamic variable at startSession", () => {
    expect(source).toContain("dynamicVariables:");
    expect(source).toMatch(/dynamicVariables:\s*\{\s*opening_line:/);
  });

  it("uses a fixed non-consequential opening line, not a computed Carson brief", () => {
    expect(STAGE2A_OPENING_LINE).toBe("Boundary proof session.");
  });

  it("still passes the account binding through customLlmExtraBody", () => {
    expect(source).toContain("customLlmExtraBody: { carson_stage2a_binding: binding.binding }");
  });
});
