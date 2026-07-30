import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateCarsonToolPolicy,
  resolveLegacyPeopleToolCommunicationRedirect,
} from "./carson-tool-policy";
import { resolveCarsonPeopleAction, type CarsonPeopleActionEnvelope } from "./carson-people-action";
import { preserveDirectCommunicationMeaning } from "./communication-vs-delegation";

const PEOPLE = [{ name: "Sana" }, { name: "Christopher" }];
const WIDGET_SOURCE = readFileSync(
  join(__dirname, "../components/home/ElevenLabsAgentWidget.tsx"),
  "utf8",
);
const RELEASE_CONTRACT = readFileSync(
  join(__dirname, "../../docs/CARSON_COMMUNICATION_ROUTING_RELEASE.md"),
  "utf8",
);
const ELEVENLABS_PATCH = readFileSync(
  join(__dirname, "../../docs/elevenlabs-prompt-patches/2026-07-30-route-people-action.md"),
  "utf8",
);
const DIAGNOSTIC_MIGRATION = readFileSync(
  join(__dirname, "../../supabase/migrations/20260801_carson_communication_routing_diagnostics.sql"),
  "utf8",
);

function policy(utterance: string, selectedTool: string, toolArguments: unknown) {
  return evaluateCarsonToolPolicy({
    utterance,
    selectedTool,
    toolArguments,
    channel: "voice",
    people: PEOPLE,
  });
}

function communicationEnvelope(
  recipient: string,
  content: string,
  overrides: Partial<CarsonPeopleActionEnvelope> = {},
): CarsonPeopleActionEnvelope {
  return {
    intendedOutcome: content,
    actionType: "interpersonal_communication",
    recipient,
    content,
    replyExpected: false,
    trackedCompletionExpected: false,
    followUpOrEscalationExpected: false,
    actualWorkRequired: false,
    ...overrides,
  };
}

describe("PROTECTED CONTRACT — plain communication stays direct", () => {
  it.each([
    ["Send Sana a WhatsApp message saying the meeting moved to four.", "the meeting moved to four."],
    ["Tell Sana the delivery arrived.", "the delivery arrived."],
    ["Let Sana know I will call tomorrow.", "I will call tomorrow."],
    ["Ask Sana to reply yes on WhatsApp.", "yes"],
    ["Tell Sana to confirm she received it.", "she received it"],
    ["Have Sana respond with the delivery time.", "the delivery time"],
    ["Get Sana to say whether she approves.", "whether she approves"],
  ])("%s", (utterance, message) => {
    expect(policy(utterance, "send_direct_whatsapp_message", {
      recipient_name: "Sana",
      message,
    })).toMatchObject({
      allowed: true,
      intent: "direct_communication",
    });
    expect(policy(utterance, "send_delegation", {
      name: "Sana",
      task: message,
    })).toMatchObject({
      allowed: false,
      intent: "direct_communication",
    });
  });
});

describe("PROTECTED CONTRACT — genuine assignments stay delegations", () => {
  it.each([
    ["Ask Christopher to buy olive oil.", "buy olive oil."],
    ["Tell Christopher to prepare the inventory report.", "prepare the inventory report."],
    ["Have Christopher call the supplier and negotiate the price.", "call the supplier and negotiate the price."],
    ["Get Christopher to complete the stock count tomorrow.", "complete the stock count tomorrow."],
  ])("%s", (utterance, task) => {
    expect(policy(utterance, "execute_instruction", { instruction: utterance }))
      .toMatchObject({ allowed: true, intent: "delegation" });
    expect(resolveLegacyPeopleToolCommunicationRedirect({
      utterance,
      selectedTool: "send_delegation",
      channel: "voice",
      toolArguments: { name: "Christopher", task },
      people: PEOPLE,
    })).toBeNull();
  });
});

describe("PROTECTED CONTRACT — ambiguous or malformed input never executes", () => {
  it.each([
    "Ask Sana.",
    "Tell Christopher.",
    "Have her reply.",
    "Get him to do it.",
  ])("%s", (utterance) => {
    expect(policy(utterance, "send_direct_whatsapp_message", {})).toMatchObject({ allowed: false });
    expect(policy(utterance, "send_delegation", {})).toMatchObject({ allowed: false });
  });

  it("requires clarification when structured people-action evidence is incomplete", () => {
    expect(resolveCarsonPeopleAction(communicationEnvelope("", "")))
      .toMatchObject({ status: "clarify", reason: "missing_recipient" });
    expect(resolveCarsonPeopleAction(communicationEnvelope("Sana", "")))
      .toMatchObject({ status: "clarify", reason: "missing_content" });
    expect(resolveCarsonPeopleAction(communicationEnvelope("Sana", "reply", {
      ambiguityReason: "pronoun did not resolve to a known person",
    }))).toMatchObject({ status: "clarify" });
  });
});

describe("PROTECTED CONTRACT — ElevenLabs payload shapes preserve meaning", () => {
  it.each([
    ["Ask Sana to reply yes on WhatsApp.", "yes", "Please reply yes on WhatsApp."],
    ["Ask Sana to reply yes on WhatsApp.", "Please reply yes on WhatsApp.", "Please reply yes on WhatsApp."],
    ["Tell Sana to confirm she received it.", "she received it", "Please confirm she received it."],
    ["Have Sana respond with the delivery time.", "the delivery time", "Please respond with the delivery time."],
    ["Get Sana to say whether she approves.", "whether she approves", "Please say whether she approves."],
  ])("normalizes transcript + payload: %s", (utterance, payload, expected) => {
    expect(preserveDirectCommunicationMeaning(utterance, "Sana", payload)).toBe(expected);
  });

  it("fails safe when the transcript is missing or delayed", () => {
    expect(preserveDirectCommunicationMeaning("", "Sana", "Please reply yes."))
      .toBe("Please reply yes.");
  });

  it("does not apply stale transcript state for a different recipient", () => {
    expect(preserveDirectCommunicationMeaning(
      "Ask Christopher to reply yes.",
      "Sana",
      "The meeting moved to four.",
    )).toBe("The meeting moved to four.");
  });

  it("uses the normalized text in the one existing duplicate/send boundary", () => {
    const handler = WIDGET_SOURCE.slice(
      WIDGET_SOURCE.indexOf("const sendDirectWhatsAppMessage = useCallback("),
      WIDGET_SOURCE.indexOf("const saveCity = useCallback("),
    );
    const normalization = handler.indexOf("preserveDirectCommunicationMeaning(");
    const duplicateGuard = handler.indexOf("isRecentDirectWhatsappDuplicate(");
    const send = handler.indexOf("createAndSendDirectMessage({");
    expect(normalization).toBeGreaterThan(-1);
    expect(normalization).toBeLessThan(duplicateGuard);
    expect(duplicateGuard).toBeLessThan(send);
    expect(handler.match(/createAndSendDirectMessage\(\{/g)).toHaveLength(1);
    expect(handler).toContain('stage: "duplicate_suppressed"');
    expect(handler).toContain("message: text");
    expect(handler).toContain("deliveryId: delivery.deliveryId");
    expect(handler).toContain("transportMessageId: delivery.messageId");
  });
});

describe("PROTECTED CONTRACT — prompt/tool parity remains a manual release gate", () => {
  it.each([
    "route_people_action",
    "send_direct_whatsapp_message",
    "send_delegation",
    "Ask Sana to reply yes on WhatsApp.",
    "interpersonal_communication",
    "tracked_delegation",
  ])("canonical release contract includes %s", (requiredText) => {
    expect(RELEASE_CONTRACT).toContain(requiredText);
  });

  it("the repository prompt patch directs new requests through route_people_action and requires truthful completion", () => {
    expect(ELEVENLABS_PATCH).toContain("never `send_direct_whatsapp_message` or `send_delegation` directly");
    expect(ELEVENLABS_PATCH).toContain("Never state or imply an outcome");
    expect(ELEVENLABS_PATCH).toContain("preserving the owner's meaning");
  });
});

describe("PROTECTED CONTRACT — persisted observability schema", () => {
  it.each([
    "legacy_people_tool_redirected",
    "duplicate_suppressed",
    "delivery_id",
    "transport_message_id",
  ])("migration preserves %s", (field) => {
    expect(DIAGNOSTIC_MIGRATION).toContain(field);
  });
});
