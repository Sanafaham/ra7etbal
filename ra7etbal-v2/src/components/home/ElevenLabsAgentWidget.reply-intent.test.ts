import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./ElevenLabsAgentWidget.tsx", import.meta.url),
  "utf8",
);

describe("ElevenLabsAgentWidget direct-message reply intent", () => {
  it("reconstructs reply meaning from the current owner transcript before duplicate checking and delivery", () => {
    const start = source.indexOf("const sendDirectWhatsAppMessage = useCallback");
    const end = source.indexOf("// Client tool: save_city", start);
    const block = source.slice(start, end);

    const transcriptIndex = block.indexOf("sessionTranscriptRef.current");
    const preservationIndex = block.indexOf("preserveDirectMessageReplyIntent");
    const duplicateIndex = block.indexOf("isRecentDirectWhatsappDuplicate");
    const deliveryIndex = block.indexOf("createAndSendDirectMessage");

    expect(transcriptIndex).toBeGreaterThan(-1);
    expect(preservationIndex).toBeGreaterThan(transcriptIndex);
    expect(duplicateIndex).toBeGreaterThan(preservationIndex);
    expect(deliveryIndex).toBeGreaterThan(duplicateIndex);
  });
});
