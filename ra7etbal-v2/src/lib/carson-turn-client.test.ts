import { describe, expect, it, vi } from "vitest";
import { dispatchCarsonReadTurn } from "./carson-turn-client";

describe("Carson old/new read ownership boundary", () => {
  it("does not let the legacy Carson path answer a turn handled by the coordinator", async () => {
    const legacyFallback = vi.fn();
    await expect(dispatchCarsonReadTurn({
      request: vi.fn().mockResolvedValue({ handled: true, ownerResult: "Tomorrow: Dentist." }),
      legacyFallback,
    })).resolves.toEqual({ ownerResult: "Tomorrow: Dentist.", owner: "turn_coordinator" });
    expect(legacyFallback).not.toHaveBeenCalled();
  });

  it("leaves unsupported turns with the unchanged legacy owner", async () => {
    await expect(dispatchCarsonReadTurn({
      request: vi.fn().mockResolvedValue({ handled: false, code: "unsupported_intent" }),
      legacyFallback: vi.fn().mockResolvedValue("Legacy response"),
    })).resolves.toEqual({ ownerResult: "Legacy response", owner: "legacy" });
  });
});
