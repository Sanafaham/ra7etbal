import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

describe("ElevenLabsAgentWidget — Voice Carson behavior guard", () => {
  it("injects the no-reconfirmation/no-idle guard into voice dynamic variables and live context", () => {
    expect(SOURCE).toContain("CARSON_VOICE_SESSION_GUARD");
    expect(SOURCE).toContain("[CARSON_STATUS_POLICY, CARSON_VOICE_SESSION_GUARD, persistentInstructions]");
    expect(SOURCE).toContain("[Voice behavior guard]");
    expect(SOURCE).toContain("conv.sendContextualUpdate(");
  });

  it("reminds the live agent after a successful delegation not to ask for permission or idle-probe", () => {
    expect(SOURCE).toContain("Do not ask whether to send it now; it has already been sent.");
    expect(SOURCE).toContain("Do not ask whether the user is still there.");
    expect(SOURCE).toContain("Do not ask whether to send now;");
    expect(SOURCE).toContain("the send already happened.");
  });
});
