import { describe, expect, it } from "vitest";
import {
  evaluateCarsonToolPolicy,
  resolveLegacyPeopleToolCommunicationRedirect,
} from "./carson-tool-policy";

const PEOPLE = [{ name: "Grace" }, { name: "Christopher" }];

function decide(
  utterance: string,
  selectedTool: string,
  toolArguments: unknown = {},
  channel: "voice" | "text" = "voice",
) {
  return evaluateCarsonToolPolicy({
    utterance, selectedTool, toolArguments, channel, people: PEOPLE,
  });
}

describe("Carson deterministic pre-dispatch policy", () => {
  it.each([
    ["Thanks Carson", "execute_instruction"],
    ["", "create_reminder"],
    ["...", "send_direct_whatsapp_message"],
    ["Call me", "send_delegation"],
  ])("blocks no-action capture %j before any tool", (utterance, tool) => {
    expect(decide(utterance, tool)).toMatchObject({ allowed: false, intent: "no_action" });
  });

  it.each([
    "create_reminder", "create_calendar_event", "send_direct_whatsapp_message",
    "execute_instruction", "save_note", "save_instruction",
  ])("blocks typed state-changing tool %s", (tool) => {
    expect(decide("Please do this", tool, { text: "do this" }, "text"))
      .toMatchObject({ allowed: false, precedence: 2 });
  });

  it("preserves typed calendar reads", () => {
    expect(decide("What is on my calendar today?", "get_calendar_events", {}, "text"))
      .toMatchObject({ allowed: true, intent: "calendar_read" });
  });

  it("gives reminder intent precedence over communication language", () => {
    const utterance = "Remind me to tell Grace that I'll be late tomorrow at 4 PM.";
    expect(decide(utterance, "create_reminder", {
      reminder_text: "tell Grace that I'll be late", time_text: "tomorrow at 4 PM",
    })).toMatchObject({ allowed: true, intent: "reminder", precedence: 3 });
    for (const tool of ["send_direct_whatsapp_message", "send_delegation", "save_note"]) {
      expect(decide(utterance, tool, { recipient_name: "Grace", message: "I'll be late" }))
        .toMatchObject({ allowed: false, intent: "reminder" });
    }
  });

  it("keeps direct communication out of tracked delegation", () => {
    const utterance = "Tell Grace I'll be late.";
    expect(decide(utterance, "send_direct_whatsapp_message", {
      recipient_name: "Grace", message: "I'll be late.",
    })).toMatchObject({ allowed: true, intent: "direct_communication" });
    expect(decide(utterance, "send_delegation", {
      person_name: "Grace", task: "I'll be late.",
    })).toMatchObject({ allowed: false, intent: "direct_communication" });
  });

  it.each([
    ["Ask Christopher to reply that we will proceed.", "reply that we will proceed."],
    ["Tell Christopher the delivery is approved.", "the delivery is approved."],
    ["Have Christopher confirm he received it.", "confirm he received it."],
    ["Get Christopher to respond yes.", "respond yes."],
  ])("redirects mistaken legacy send_delegation for plain communication: %s", (utterance, task) => {
    const result = resolveLegacyPeopleToolCommunicationRedirect({
      utterance,
      channel: "voice",
      selectedTool: "send_delegation",
      toolArguments: { name: "Christopher", task },
      people: PEOPLE,
    });

    expect(result).toMatchObject({
      originalTool: "send_delegation",
      finalTool: "send_direct_whatsapp_message",
      params: { recipient_name: "Christopher", message: task },
      policyDecision: { intent: "direct_communication", missingEntities: [] },
    });
  });

  it.each([
    ["Ask Christopher to buy olive oil tomorrow.", "buy olive oil tomorrow."],
    ["Assign Christopher to prepare dinner and track it until completion.", "prepare dinner and track it until completion."],
    ["Have Christopher confirm completion and keep following up.", "confirm completion and keep following up."],
  ])("does not reinterpret genuine tracked work as a message: %s", (utterance, task) => {
    expect(resolveLegacyPeopleToolCommunicationRedirect({
      utterance,
      channel: "voice",
      selectedTool: "send_delegation",
      toolArguments: { name: "Christopher", task },
      people: PEOPLE,
    })).toBeNull();
  });

  it("does not redirect typed calls, missing content, or an unknown recipient", () => {
    expect(resolveLegacyPeopleToolCommunicationRedirect({
      utterance: "Tell Christopher the delivery is approved.",
      channel: "text",
      selectedTool: "send_delegation",
      toolArguments: { name: "Christopher", task: "the delivery is approved." },
      people: PEOPLE,
    })).toBeNull();
    expect(resolveLegacyPeopleToolCommunicationRedirect({
      utterance: "Tell Christopher the delivery is approved.",
      channel: "voice",
      selectedTool: "send_delegation",
      toolArguments: { name: "Christopher", task: "" },
      people: PEOPLE,
    })).toBeNull();
    expect(resolveLegacyPeopleToolCommunicationRedirect({
      utterance: "Tell Ahmad the delivery is approved.",
      channel: "voice",
      selectedTool: "send_delegation",
      toolArguments: { name: "Ahmad", task: "the delivery is approved." },
      people: PEOPLE,
    })).toBeNull();
  });

  it("keeps call me communication on the direct path", () => {
    expect(decide("Tell Grace to call me when she arrives.", "send_direct_whatsapp_message", {
      recipient_name: "Grace", message: "Call Sana when you arrive.",
    })).toMatchObject({ allowed: true, intent: "direct_communication" });
  });

  // Confirmed production regression (2026-07-29): this exact utterance was
  // misrouted to "delegation" (router matched the generic "Ask [Name] to"
  // pattern), so send_direct_whatsapp_message was rejected — "Required
  // entities are missing: task." — with zero network call (0ms), and
  // Carson's own reply then fabricated an unrelated "sent" claim. Fixed by
  // teaching isCommunicationStyleTaskText that "reply/respond" as the whole
  // delegated task is inherently communication, not trackable work.
  it("allows the exact confirmed 'ask X to reply' regression through send_direct_whatsapp_message", () => {
    const utterance =
      "Ask Christopher to reply, \"Test received.\" This is just a PolicyGate test. No action needed.";
    expect(decide(utterance, "send_direct_whatsapp_message", {
      recipient_name: "Christopher", message: "Test received.",
    })).toMatchObject({ allowed: true, intent: "direct_communication" });
    expect(decide(utterance, "execute_instruction", { instruction: utterance }))
      .toMatchObject({ allowed: false, intent: "direct_communication" });
  });

  it.each([
    ["Tell Christopher test received.", { recipient_name: "Christopher", message: "test received." }],
    ["Send Christopher a message saying test received.",
      { recipient_name: "Christopher", message: "test received." }],
  ])("routes '%s' to direct communication (already correct, permanent coverage)", (utterance, args) => {
    expect(decide(utterance, "send_direct_whatsapp_message", args))
      .toMatchObject({ allowed: true, intent: "direct_communication" });
  });

  // Confirmed production incident (2026-07-29, ~21:57 Turkey time): a garbled
  // voice transcript of "Ask Christopher to reply yes if he can come tomorrow
  // night." was heard as an "Ask Christopher if he can ... to reply/send yes"
  // shape — the router's own "check-in delegation" pattern for "Ask [Name]
  // if/whether". directCommunicationIntent's extraction regex previously
  // required "to" within one word of the name, so it never even tried
  // isCommunicationStyleTaskText for this shape — evaluateCarsonToolPolicy
  // rejected send_direct_whatsapp_message with "Required entities are
  // missing: task." confirmed via carson_tool_diagnostics (policy_rejected,
  // 0ms after invoked, no handler_started, no backend/transport reached).
  it("allows an 'Ask [Name] if he can ... to reply' check-in-shaped phrasing through send_direct_whatsapp_message", () => {
    const utterance = "Ask Christopher if he can to reply yes if he can come tomorrow night.";
    expect(decide(utterance, "send_direct_whatsapp_message", {
      recipient_name: "Christopher", message: "yes if he can come tomorrow night",
    })).toMatchObject({ allowed: true, intent: "direct_communication" });
  });

  // The router's "check-in delegation" pattern for "Ask [Name] if/whether"
  // must still work when there is no reply/respond clause at all — this fix
  // only reclassifies when the text after "to" itself reads as
  // communication-style; it must not swallow genuine check-in delegation.
  it("keeps a genuine 'Ask [Name] if he can help' check-in as delegation, with no reply clause", () => {
    const utterance = "Ask Christopher if he can help me clean the garage.";
    expect(decide(utterance, "execute_instruction", { instruction: utterance }))
      .toMatchObject({ allowed: true, intent: "delegation" });
    expect(decide(utterance, "send_direct_whatsapp_message", {
      recipient_name: "Christopher", message: "help me clean the garage",
    })).toMatchObject({ allowed: false, intent: "delegation" });
  });

  it("allows clear operational delegation through existing execution", () => {
    const utterance = "Tell Grace to prepare dinner.";
    expect(decide(utterance, "execute_instruction", { instruction: utterance }))
      .toMatchObject({ allowed: true, intent: "delegation", precedence: 5 });
    expect(decide(utterance, "send_direct_whatsapp_message", {
      recipient_name: "Grace", message: "Prepare dinner.",
    })).toMatchObject({ allowed: false, intent: "delegation" });
  });

  it.each([
    ["Remember that Grace prefers morning shifts.", "save_instruction",
      { instruction: "Grace prefers morning shifts." }, "memory"],
    ["Save a note that the guest prefers still water.", "save_note",
      { note: "The guest prefers still water." }, "note"],
  ])("protects explicit intent for %s", (utterance, tool, args, intent) => {
    expect(decide(utterance, tool, args)).toMatchObject({ allowed: true, intent });
    expect(decide(utterance, "execute_instruction", args)).toMatchObject({ allowed: false, intent });
  });

  it.each([
    ["What is on my calendar tomorrow?", "get_calendar_events", "calendar_read",
      {}],
    ["Add dentist to my calendar tomorrow at 11.", "create_calendar_event", "calendar_mutation",
      { title: "Dentist", date: "2026-08-01", time: "11:00" }],
    ["Move my dentist calendar event to noon.", "update_calendar_event", "calendar_mutation",
      { event_id: "evt_123", time: "12:00" }],
    ["Delete the dentist event from my calendar.", "delete_calendar_event", "calendar_mutation",
      { event_id: "evt_123" }],
  ])("distinguishes calendar operation: %s", (utterance, tool, intent, toolArgs) => {
    expect(decide(utterance, tool, toolArgs)).toMatchObject({ allowed: true, intent });
  });

  it("rejects a conflicting calendar mutation tool", () => {
    expect(decide("Delete the dentist event from my calendar.", "create_calendar_event", {
      title: "Dentist", date: "2026-08-01", time: "11:00",
    })).toMatchObject({ allowed: false, intent: "calendar_mutation" });
  });

  it.each([
    ["Add dentist to my calendar.", "create_calendar_event", {}, "calendar_action"],
    ["Move my dentist calendar event.", "update_calendar_event", {}, "calendar_action"],
    ["Delete the dentist event from my calendar.", "delete_calendar_event", {}, "calendar_action"],
  ])("blocks calendar mutation missing required evidence: %s", (utterance, tool, args, missing) => {
    const result = decide(utterance, tool, args);
    expect(result.allowed).toBe(false);
    expect(result.missingEntities).toContain(missing);
  });

  it.each([
    ["Remind me to call the school.", "create_reminder",
      { reminder_text: "call the school" }, "time"],
    ["Tell Ahmad I'll be late.", "send_direct_whatsapp_message",
      { recipient_name: "Ahmad", message: "I'll be late." }, "known_person"],
    ["Tell Grace I'll be late.", "send_direct_whatsapp_message",
      { recipient_name: "Grace" }, "message"],
  ])("missing entity blocks with one clarification: %s", (utterance, tool, args, missing) => {
    const result = decide(utterance, tool, args);
    expect(result.allowed).toBe(false);
    expect(result.missingEntities).toContain(missing);
    expect(result.outcome.split("?").length - 1).toBeLessThanOrEqual(1);
  });

  it("rejects ambiguous mutation instead of guessing", () => {
    expect(decide("Handle this somehow.", "execute_instruction", {
      instruction: "Handle this somehow.",
    })).toMatchObject({ allowed: false, eligibleTools: [] });
  });

  it("denies an unclassified future tool instead of failing open", () => {
    expect(decide("Handle this somehow.", "future_state_changing_tool", {
      instruction: "Handle this somehow.",
    })).toMatchObject({
      allowed: false,
      eligibleTools: [],
      reason: "The selected tool is not classified by the deterministic policy and is denied by default.",
    });
  });

  it("preserves the existing hosting execution path", () => {
    const utterance = "Arrange dinner for the guests tonight.";
    expect(decide(utterance, "execute_instruction", { instruction: utterance }))
      .toMatchObject({ allowed: true, intent: "hosting" });
  });

  it("keeps an active hosting clarification inside hosting execution", () => {
    expect(evaluateCarsonToolPolicy({
      utterance: "Six guests.",
      selectedTool: "execute_instruction",
      toolArguments: { instruction: "Six guests." },
      channel: "voice",
      people: PEOPLE,
      hasActiveHostingClarification: true,
    })).toMatchObject({ allowed: true, intent: "hosting" });
  });

  it("recognizes recurring reminder intent without requiring the word remind", () => {
    expect(decide("Every day at 8 AM check the gate.", "create_automation", {
      instruction: "check the gate", first_run_text: "today at 8 AM",
    })).toMatchObject({ allowed: true, intent: "reminder" });
  });
});
