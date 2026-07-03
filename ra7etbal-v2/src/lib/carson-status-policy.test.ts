import { describe, expect, it } from "vitest";
import { CARSON_STATUS_POLICY, CARSON_VOICE_SESSION_GUARD } from "./carson-status-policy";

describe("Carson voice behavior policy", () => {
  it("tells Voice Carson to execute clear delegations without a second permission request", () => {
    expect(CARSON_STATUS_POLICY).toContain("Clear delegation instructions are enough permission to act");
    expect(CARSON_STATUS_POLICY).toContain("call the delegation tool immediately");
    expect(CARSON_STATUS_POLICY).toContain("Never ask \"shall I send this now\"");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("Ask Christopher to make this for dinner");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("execute immediately");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("Do not ask for permission again");
  });

  it("bans idle probing after completed actions", () => {
    expect(CARSON_STATUS_POLICY).toContain("Silence after completing an action is better");
    expect(CARSON_STATUS_POLICY).toContain("\"Are you still with me?\"");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("If the user is silent after you complete an action, remain silent and wait");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("Never ask \"shall I send this now\"");
    expect(CARSON_VOICE_SESSION_GUARD).toContain("\"are you still with me\"");
  });
});
