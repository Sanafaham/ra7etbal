import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — direct WhatsApp duplicate guard", () => {
  it("keeps a dedicated direct WhatsApp duplicate store separate from delegation and follow-up guards", () => {
    expect(SOURCE).toContain(
      "const recentDirectWhatsappMessagesRef = useRef<Map<string, number>>(new Map());",
    );
    expect(SOURCE).toContain("isRecentDirectWhatsappDuplicate");
    expect(SOURCE).toContain("recordDirectWhatsappSent");
  });

  it("checks duplicate direct messages before creating a message row or WhatsApp delivery", () => {
    const duplicateBlock = blockBetween(
      "if (\n        isRecentDirectWhatsappDuplicate(",
      "try {\n        const { message, delivery } = await createAndSendDirectMessage({",
    );

    expect(duplicateBlock).toContain("recentDirectWhatsappMessagesRef.current");
    expect(duplicateBlock).toContain("person.name");
    expect(duplicateBlock).toContain("text");
    expect(duplicateBlock).toContain("direct_whatsapp_tool_duplicate_blocked");
    expect(duplicateBlock).toContain(
      "return `I already sent ${person.name} that message just now. I won't send it again.`;",
    );
    expect(duplicateBlock).not.toContain("createAndSendDirectMessage");
    expect(duplicateBlock).not.toContain("createMessageFn");
  });

  it("records the duplicate key only after a successful direct WhatsApp send", () => {
    const successBlock = blockBetween(
      "console.log(\"[direct_whatsapp_tool_delivery_result]\", {",
      "return `WhatsApp accepted the message to ${person.name}. I'll watch for delivery updates.`;",
    );

    expect(successBlock).toContain("success: true");
    expect(successBlock).toContain(
      "recordDirectWhatsappSent(recentDirectWhatsappMessagesRef.current, person.name, text);",
    );
  });

  it("keeps WhatsApp failure reporting truthful and does not mark failures as sent", () => {
    const catchBlock = blockBetween(
      "} catch (err) {\n        const errMsg = err instanceof Error ? err.message : String(err);",
      "}\n    },\n    [sendDelegation],\n  );\n\n  // ------------------------------------------------------------------\n  // Client tool: save_city",
    );

    expect(catchBlock).toContain("return `I couldn't send ${person.name} the message. Please try again.`;");
    expect(catchBlock).not.toContain("recordDirectWhatsappSent");
  });

  it("does not add the direct WhatsApp duplicate guard to delegation or follow-up paths", () => {
    const followupBlock = blockBetween(
      "// Client tool: send_followup",
      "// Client tool: send_delegation",
    );
    const delegationBlock = blockBetween(
      "// Client tool: send_delegation",
      "// Client tool: create_reminder",
    );

    expect(followupBlock).toContain("lastSentRef.current");
    expect(followupBlock).not.toContain("recentDirectWhatsappMessagesRef");
    expect(followupBlock).not.toContain("isRecentDirectWhatsappDuplicate");
    expect(delegationBlock).toContain("findRecentDuplicateDelegation");
    expect(delegationBlock).not.toContain("recentDirectWhatsappMessagesRef");
    expect(delegationBlock).not.toContain("isRecentDirectWhatsappDuplicate");
  });
});
