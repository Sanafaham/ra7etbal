import { describe, expect, it } from "vitest";
import {
  extractPersonNameParam,
  extractMessageParam,
  extractTaskParam,
  extractNoteParam,
  extractTimeTextParam,
  extractCityParam,
  extractQueryParam,
  extractCalendarTitleParam,
  extractEventIdParam,
  extractAutomationInstructionParam,
} from "./carson-tool-params";

describe("extractPersonNameParam", () => {
  it("reads the exact key currently in use first", () => {
    expect(extractPersonNameParam({ name: "Grace" }, "name")).toBe("Grace");
    expect(extractPersonNameParam({ recipient_name: "Grace" }, "recipient_name")).toBe("Grace");
  });

  it.each(["person_name", "recipient_name", "assignee_name", "to"])(
    "falls back to '%s' when the primary key is absent",
    (key) => {
      expect(extractPersonNameParam({ [key]: "Grace" })).toBe("Grace");
    },
  );

  it("prefers the declared primary key over other synonyms when both are present", () => {
    expect(extractPersonNameParam({ recipient_name: "Grace", name: "wrong" }, "recipient_name")).toBe(
      "Grace",
    );
  });
});

describe("extractMessageParam", () => {
  it("reads 'message' and falls back to text/body/content", () => {
    expect(extractMessageParam({ message: "hi" })).toBe("hi");
    expect(extractMessageParam({ text: "hi" })).toBe("hi");
    expect(extractMessageParam({ body: "hi" })).toBe("hi");
    expect(extractMessageParam({ content: "hi" })).toBe("hi");
  });
});

describe("extractTaskParam", () => {
  it("reads 'task' and falls back to instruction/description/text/title", () => {
    expect(extractTaskParam({ task: "buy flowers" })).toBe("buy flowers");
    expect(extractTaskParam({ instruction: "buy flowers" })).toBe("buy flowers");
    expect(extractTaskParam({ description: "buy flowers" })).toBe("buy flowers");
  });
});

describe("extractNoteParam", () => {
  it("reads 'note' and falls back to text/content/description", () => {
    expect(extractNoteParam({ note: "idea" })).toBe("idea");
    expect(extractNoteParam({ description: "idea" })).toBe("idea");
  });
});

describe("extractTimeTextParam", () => {
  it("reads 'time_text' and falls back to time/date/when", () => {
    expect(extractTimeTextParam({ time_text: "tomorrow at 5pm" })).toBe("tomorrow at 5pm");
    expect(extractTimeTextParam({ when: "tomorrow at 5pm" })).toBe("tomorrow at 5pm");
  });

  it("does not fall back to due_at — that is handled separately as an ISO-only value", () => {
    expect(extractTimeTextParam({ due_at: "2026-06-28T00:00:00Z" })).toBe("");
  });
});

describe("extractCityParam", () => {
  it("reads 'city' and falls back to location/place", () => {
    expect(extractCityParam({ city: "Beirut" })).toBe("Beirut");
    expect(extractCityParam({ location: "Beirut" })).toBe("Beirut");
    expect(extractCityParam({ place: "Beirut" })).toBe("Beirut");
  });
});

describe("extractQueryParam", () => {
  it("reads 'query' and falls back to text/title/note", () => {
    expect(extractQueryParam({ query: "flowers" })).toBe("flowers");
    expect(extractQueryParam({ note: "flowers" })).toBe("flowers");
  });
});

describe("extractCalendarTitleParam", () => {
  it("reads 'title' and falls back to event_title/name/description", () => {
    expect(extractCalendarTitleParam({ title: "Dentist" })).toBe("Dentist");
    expect(extractCalendarTitleParam({ event_title: "Dentist" })).toBe("Dentist");
    expect(extractCalendarTitleParam({ description: "Dentist" })).toBe("Dentist");
  });
});

describe("extractEventIdParam", () => {
  it("reads 'event_id' and falls back to id/eventId", () => {
    expect(extractEventIdParam({ event_id: "evt_1" })).toBe("evt_1");
    expect(extractEventIdParam({ id: "evt_1" })).toBe("evt_1");
    expect(extractEventIdParam({ eventId: "evt_1" })).toBe("evt_1");
  });
});

describe("extractAutomationInstructionParam", () => {
  it("reads 'instruction' and falls back to task/message/description/text", () => {
    expect(extractAutomationInstructionParam({ instruction: "check the kitchen" })).toBe(
      "check the kitchen",
    );
    expect(extractAutomationInstructionParam({ task: "check the kitchen" })).toBe(
      "check the kitchen",
    );
    expect(extractAutomationInstructionParam({ description: "check the kitchen" })).toBe(
      "check the kitchen",
    );
  });
});
