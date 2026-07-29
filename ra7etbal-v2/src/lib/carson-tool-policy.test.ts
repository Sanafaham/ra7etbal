import { describe, expect, it } from "vitest";
import { evaluateCarsonToolPolicy } from "./carson-tool-policy";

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

  it("keeps call me communication on the direct path", () => {
    expect(decide("Tell Grace to call me when she arrives.", "send_direct_whatsapp_message", {
      recipient_name: "Grace", message: "Call Sana when you arrive.",
    })).toMatchObject({ allowed: true, intent: "direct_communication" });
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
    ["What is on my calendar tomorrow?", "get_calendar_events", "calendar_read"],
    ["Add dentist to my calendar tomorrow at 11.", "create_calendar_event", "calendar_mutation"],
    ["Move my dentist calendar event to noon.", "update_calendar_event", "calendar_mutation"],
    ["Delete the dentist event from my calendar.", "delete_calendar_event", "calendar_mutation"],
  ])("distinguishes calendar operation: %s", (utterance, tool, intent) => {
    expect(decide(utterance, tool, { title: "Dentist", date: "tomorrow", time: "11:00" }))
      .toMatchObject({ allowed: true, intent });
  });

  it("rejects a conflicting calendar mutation tool", () => {
    expect(decide("Delete the dentist event from my calendar.", "create_calendar_event", {
      title: "Dentist",
    })).toMatchObject({ allowed: false, intent: "calendar_mutation" });
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
