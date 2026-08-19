import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => ({ supabase: {} }));
vi.mock("../hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@elevenlabs/react", () => ({ Conversation: { startSession: vi.fn() } }));

import { isCarsonBoundaryProofPath } from "./CarsonBoundaryProof";

describe("Stage 2A route isolation", () => {
  it("selects only the exact non-production proof path", () => {
    expect(isCarsonBoundaryProofPath("/non-production/carson-boundary-proof")).toBe(true);
    expect(isCarsonBoundaryProofPath("/")).toBe(false);
    expect(isCarsonBoundaryProofPath("/non-production/carson-boundary-proof/extra")).toBe(false);
  });
});
