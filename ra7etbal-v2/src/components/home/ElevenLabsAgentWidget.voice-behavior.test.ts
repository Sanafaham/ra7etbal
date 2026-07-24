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
    expect(SOURCE).toContain("[CARSON_STATUS_POLICY, CARSON_VOICE_SESSION_GUARD, hostingToolPolicy, persistentInstructions]");
    expect(SOURCE).toContain("[Voice behavior guard]");
    expect(SOURCE).toContain("conv.sendContextualUpdate(");
  });

  it("requires every voice hosting turn to use the shared execute_instruction handler", () => {
    expect(SOURCE).toContain("For every new hosting request or hosting clarification, call execute_instruction");
    expect(SOURCE).toContain("Never answer hosting from conversation history or ra7etbal_state alone.");
    expect(SOURCE).toContain("pendingOperationDraft = await loadActiveHostingDraft().catch(() => null)");
    expect(SOURCE).toContain("handleOperationalHostingTurn({");
  });

  it("does not start a greeting over a restored hosting clarification", () => {
    expect(SOURCE).toContain("const activeHostingDraft = pendingHostingClarificationRef.current");
    expect(SOURCE).toContain('const openingLine = activeHostingDraft || hasTypedHistory\n      ? ""');
    expect(SOURCE).toContain("Do not greet or start a new topic; wait for the owner's clarification answer");
  });

  it("reminds the live agent after a successful delegation not to ask for permission or idle-probe", () => {
    expect(SOURCE).toContain("Do not ask whether to send it now; it has already been sent.");
    expect(SOURCE).toContain("Do not ask whether the user is still there.");
    expect(SOURCE).toContain("Do not ask whether to send now;");
    expect(SOURCE).toContain("the send already happened.");
  });

  it("instructs Voice Carson to repeat instead of acting on invalid speech capture", () => {
    const policy = readFileSync(
      join(__dirname, "../../lib/carson-status-policy.ts"),
      "utf-8",
    );
    expect(policy).toContain("empty, \"...\", punctuation-only, or a clipped fragment like \"Call me\"");
    expect(policy).toContain("do not infer from old context and do not call any tool");
    expect(policy).toContain("CARSON_REPEAT_PROMPT");
  });
});
