import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFollowUpRecipientText, resolveStoredMessageForResend } from "./stored-recipient-text";

/**
 * Protected: Talk's send_followup and the TaskCard re-send — two
 * recipient-facing sends found by the bypass audit — reach the recipient only
 * through the single owner-perspective boundary (shared/owner-perspective.js),
 * fail closed with a truthful owner-facing result, and add no model call.
 */

const follow = (modelMessage: string | null, storedDescription: string | null = null, recipientName = "Grace", ownerName: string | null = "Sana") =>
  resolveFollowUpRecipientText({ modelMessage, storedDescription, ownerName, recipientName });
const resend = (content: string, recipientName = "Grace", ownerName: string | null = "Sana") =>
  resolveStoredMessageForResend({ content, ownerName, recipientName });

describe("Talk send_followup — model-supplied follow-up text", () => {
  it.each([
    ["Can you confirm the delivery?", "Can you confirm the delivery?"],
    ["Let me know when it's done.", "Let Sana know when it's done."],
    ["Please remind Loulya to call me.", "Please remind Loulya to call Sana."],
    ["Did you put the bags in my room?", "Did you put the bags in Sana's room?"],
  ])("%j is sent as %j (owner named, recipient 'you', third party kept)", (input, expected) => {
    expect(follow(input)).toEqual({ ok: true, text: expected });
  });

  it.each([
    "Ali said I would pay.",
    "Tell Grace I'm running late.",
    "I did it myself.",
    "الغدا جاهز",
    "Akşam yemeği hazır",
  ])("unresolvable %j fails closed with a truthful tool result (nothing to send)", (input) => {
    const result = follow(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response).toMatch(/^I didn't send the follow-up to Grace\./);
      expect(result.response).not.toMatch(/has the follow-up/);
    }
  });
});

describe("Talk send_followup — stored task follow-up (same builder as the escalation cron)", () => {
  it.each([
    ["put it in my room", "Following up: put it in Sana's room"],
    ["Bring the car at 5.", "Following up: Bring the car at 5."],
    ["Take Loulya to her appointment and call me after.", "Following up: Take Loulya to her appointment and call Sana after."],
  ])("stored %j → %j", (description, expected) => {
    expect(follow(null, description)).toEqual({ ok: true, text: expected });
  });

  it.each(["I did it myself", "Grace said I would call back", "text you in one minute", "Tell Grace Sana is late", "الغدا جاهز", "Eve geliyorum"])(
    "ambiguous historical description %j gets the neutral line, never reinterpreted", (description) => {
      expect(follow(null, description)).toEqual({ ok: true, text: "Following up on the task Sana sent you." });
    });

  it("the retired \"Let me know when done.\" template (raw owner 'me') is gone", () => {
    expect(follow(null, "buy flowers")).toEqual({ ok: true, text: "Following up: buy flowers" });
  });
});

describe("TaskCard re-send of a stored message row", () => {
  it.each([
    ["Hi Grace, could you buy flowers? Let Sana know when done.", "Hi Grace, could you buy flowers? Let Sana know when done."],
    ["Dinner is at 8.", "Dinner is at 8."],
    ["Call me when you're done.", "Call Sana when you're done."],
    ["I'm running late.", "Sana is running late."],
  ])("%j is re-sent as %j", (content, expected) => {
    expect(resend(content)).toEqual({ ok: true, text: expected });
  });

  it.each([
    ["Hi Sarah, could you tell Sarah Sana is running late? Let Sana know when done.", "Sarah"],
    ["Grace said I would call back.", "Loulya"],
    ["I did it myself.", "Grace"],
  ])("unresolvable historical row %j is not re-sent; the owner is told why", (content, recipient) => {
    const result = resend(content, recipient);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response).toMatch(new RegExp(`^Not sent: .* saved message to ${recipient}\\.`));
      expect(result.response).toMatch(/Message them yourself, or ask Carson to send it again using names\./);
    }
  });
});

describe("TaskCard re-send of a saved Arabic/Turkish message (checker L1)", () => {
  it.each(["الغدا جاهز", "Akşam yemeği hazır"])("%j is not re-sent, and the owner is told the real reason (language, not 'I/me/her')", (content) => {
    const result = resend(content, "Grace");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response).toBe("Not sent: I can't re-check an Arabic or Turkish saved message to Grace before sending it again. "
        + "Message them yourself, or ask Carson to send it again.");
    }
  });
});

describe("wiring — the checks run before anything is saved or sent, with no model call", () => {
  const widget = readFileSync(join(__dirname, "../components/home/ElevenLabsAgentWidget.tsx"), "utf-8");
  const taskCard = readFileSync(join(__dirname, "../components/tasks/TaskCard.tsx"), "utf-8");
  const helper = readFileSync(join(__dirname, "stored-recipient-text.ts"), "utf-8");

  it("send_followup resolves the text before createTask/createMessage/sendWhatsAppTask and returns the refusal", () => {
    const start = widget.indexOf("const sendFollowup = useCallback(");
    const body = widget.slice(start, widget.indexOf("// Client tool: send_delegation", start));
    const check = body.indexOf("resolveFollowUpRecipientText(");
    expect(check).toBeGreaterThan(0);
    expect(body).toMatch(/if \(!followUpText\.ok\) return followUpText\.response;/);
    for (const call of ["createTask(", "createMessage(", "sendWhatsAppTask("]) {
      expect(body.indexOf(call), call).toBeGreaterThan(check);
    }
    expect(widget).not.toMatch(/Let me know when done\./);
    expect(widget).not.toMatch(/function buildFollowUpText/);
  });

  it("TaskCard re-send resolves the stored row before sendWhatsAppTask and sends only the resolved text", () => {
    const start = taskCard.indexOf("async function send()");
    const body = taskCard.slice(start, taskCard.indexOf("const assignedLabel", start));
    const check = body.indexOf("resolveStoredMessageForResend(");
    expect(check).toBeGreaterThan(0);
    expect(body.indexOf("sendWhatsAppTask(")).toBeGreaterThan(check);
    expect(body).toMatch(/if \(!resend\.ok\) \{\s*window\.alert\(resend\.response\);\s*return;/);
    expect(body).toMatch(/messageText: resend\.text,/);
  });

  it("the helper adds no model call and no second pronoun rewriter (it only calls the shared boundary)", () => {
    expect(helper).not.toMatch(/anthropic|compose-message|callAnthropicProxy/);
    expect(helper).not.toMatch(/\.replace\(/);
  });
});
