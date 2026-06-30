import { describe, expect, it, vi } from "vitest";
import {
  parseDelegationFastPath,
  executeDelegationFastPath,
} from "./delegation-fast-path";
import type { Person } from "../types/person";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-1",
    user_id: "user-1",
    name: "Nasira",
    role: "staff",
    phone: "+971500000001",
    notes: null,
    created_at: "2026-06-24T00:00:00.000Z",
    relationship: null,
    is_family: false,
    responsibilities: null,
    reliability_level: null,
    follow_up_level: null,
    delegation_guidance: null,
    should_not_assign: null,
    escalate_to: null,
    communication_style: null,
    whatsapp_opted_in: true,
    whatsapp_consent_at: "2026-06-24T00:00:00.000Z",
    whatsapp_consent_method: "owner_confirmed",
    ...overrides,
  };
}

function roster(nasiraOverrides: Partial<Person> = {}): Person[] {
  return [
    person({ name: "Nasira", phone: "+971500000001", ...nasiraOverrides }),
    person({ id: "person-2", name: "Ghulam", phone: "+971500000002" }),
    person({ id: "person-3", name: "Grace", phone: "+971500000003" }),
    person({ id: "person-4", name: "Christopher", phone: "+971500000004" }),
  ];
}

// ── parseDelegationFastPath ───────────────────────────────────────────────────

describe("parseDelegationFastPath", () => {
  it("parses 'ask [name] to [task]'", () => {
    expect(
      parseDelegationFastPath("ask Nasira to clean the bedrooms", roster()),
    ).toEqual({ personName: "Nasira", taskText: "clean the bedrooms" });
  });

  it("parses 'tell [name] to [task]'", () => {
    expect(
      parseDelegationFastPath("tell Ghulam to bring the car", roster()),
    ).toEqual({ personName: "Ghulam", taskText: "bring the car" });
  });

  it("parses 'get [name] to [task]'", () => {
    expect(
      parseDelegationFastPath("get Grace to call me", roster()),
    ).toEqual({ personName: "Grace", taskText: "call me" });
  });

  it("parses 'have [name] [task]'", () => {
    expect(
      parseDelegationFastPath("have Christopher prepare dinner", roster()),
    ).toEqual({ personName: "Christopher", taskText: "prepare dinner" });
  });

  it("strips accidental 'to' in 'have [name] to [task]'", () => {
    expect(
      parseDelegationFastPath("have Ghulam to bring the car", roster()),
    ).toEqual({ personName: "Ghulam", taskText: "bring the car" });
  });

  it("parses with leading 'please'", () => {
    expect(
      parseDelegationFastPath("please ask Nasira to clean the bedrooms", roster()),
    ).toEqual({ personName: "Nasira", taskText: "clean the bedrooms" });
  });

  it("parses a longer task description", () => {
    expect(
      parseDelegationFastPath(
        "ask Nasira to clean the bedrooms and prepare them for turndown now",
        roster(),
      ),
    ).toEqual({
      personName: "Nasira",
      taskText: "clean the bedrooms and prepare them for turndown now",
    });
  });

  it("returns null for unknown person (falls through to Anthropic)", () => {
    expect(
      parseDelegationFastPath("ask Ahmad to clean the kitchen", roster()),
    ).toBeNull();
  });

  it("returns null for 'and tell him/her/them' personal note patterns", () => {
    expect(
      parseDelegationFastPath(
        "ask Grace to call me and tell her I miss her",
        roster(),
      ),
    ).toBeNull();

    expect(
      parseDelegationFastPath(
        "tell Ghulam to bring the car and tell him thank you",
        roster(),
      ),
    ).toBeNull();
  });

  it("returns null for multi-person conjunction patterns ('and also ask/tell')", () => {
    expect(
      parseDelegationFastPath(
        "ask Nasira to clean and also ask Grace to set the table",
        roster(),
      ),
    ).toBeNull();

    expect(
      parseDelegationFastPath(
        "ask Nasira to clean and also tell Grace to prepare dinner",
        roster(),
      ),
    ).toBeNull();
  });

  it("returns null when 'tell Grace and Nasira' — name candidate is 'Grace and' which has no match", () => {
    expect(
      parseDelegationFastPath("tell Grace and Nasira to clean", roster()),
    ).toBeNull();
  });

  it("returns null when task text is too short (< 3 chars)", () => {
    // "go" is 2 chars, fails the taskText.length >= 3 guard
    expect(
      parseDelegationFastPath("ask Nasira to go", roster()),
    ).toBeNull();
  });
});

// ── executeDelegationFastPath ─────────────────────────────────────────────────

describe("executeDelegationFastPath", () => {
  it("routes 'ask Nasira to clean the bedrooms' through fast path without /api/anthropic", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const sendDelegationFn = vi
      .fn()
      .mockResolvedValue(
        "Sent delegation to Nasira: clean the bedrooms and prepare for turndown.",
      );

    const result = await executeDelegationFastPath(
      "ask Nasira to clean the bedrooms and prepare for turndown",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "sent",
      personName: "Nasira",
      taskText: "clean the bedrooms and prepare for turndown",
    });
    expect(sendDelegationFn).toHaveBeenCalledWith({
      name: "Nasira",
      task: "clean the bedrooms and prepare for turndown",
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/anthropic")),
    ).toBe(false);

    vi.unstubAllGlobals();
  });

  it("routes 'tell Ghulam to bring the car' through fast path", async () => {
    const sendDelegationFn = vi
      .fn()
      .mockResolvedValue("Sent delegation to Ghulam: bring the car.");

    const result = await executeDelegationFastPath(
      "tell Ghulam to bring the car",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "sent",
      personName: "Ghulam",
      taskText: "bring the car",
    });
    expect(sendDelegationFn).toHaveBeenCalledWith({ name: "Ghulam", task: "bring the car" });
  });

  it("routes 'have Christopher prepare dinner' through fast path", async () => {
    const sendDelegationFn = vi
      .fn()
      .mockResolvedValue("Sent delegation to Christopher: prepare dinner.");

    const result = await executeDelegationFastPath(
      "have Christopher prepare dinner",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "sent",
      personName: "Christopher",
      taskText: "prepare dinner",
    });
  });

  it("falls through for compound multi-person instructions", async () => {
    const sendDelegationFn = vi.fn();

    const result = await executeDelegationFastPath(
      "ask Nasira to clean and also ask Grace to set the table",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({ handled: false, reason: "no_match" });
    expect(sendDelegationFn).not.toHaveBeenCalled();
  });

  it("falls through for 'and tell her' personal note instructions", async () => {
    const sendDelegationFn = vi.fn();

    const result = await executeDelegationFastPath(
      "ask Grace to call me and tell her I miss her",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({ handled: false, reason: "no_match" });
    expect(sendDelegationFn).not.toHaveBeenCalled();
  });

  it("falls through when person name has no match in People", async () => {
    const sendDelegationFn = vi.fn();

    const result = await executeDelegationFastPath(
      "ask Ahmad to clean the kitchen",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({ handled: false, reason: "no_match" });
    expect(sendDelegationFn).not.toHaveBeenCalled();
  });

  it("blocks and returns spoken error when person has no phone — does not call send", async () => {
    const sendDelegationFn = vi.fn();

    const result = await executeDelegationFastPath(
      "ask Nasira to clean the bedrooms",
      {
        people: roster({ phone: "" }),
        userId: "user-1",
        displayName: "Sana",
      },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "blocked",
      reason: "missing_phone",
      personName: "Nasira",
    });
    expect(sendDelegationFn).not.toHaveBeenCalled();
  });

  it("blocks and returns spoken error when person has no WhatsApp consent — does not call send", async () => {
    const sendDelegationFn = vi.fn();

    const result = await executeDelegationFastPath(
      "tell Nasira to clean the bedrooms",
      {
        people: roster({ whatsapp_opted_in: false }),
        userId: "user-1",
        displayName: "Sana",
      },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "blocked",
      reason: "missing_consent",
      personName: "Nasira",
    });
    expect(sendDelegationFn).not.toHaveBeenCalled();
  });

  it("returns failed status when sendDelegationFn throws", async () => {
    const sendDelegationFn = vi
      .fn()
      .mockRejectedValue(new Error("Network error"));

    const result = await executeDelegationFastPath(
      "ask Nasira to clean the bedrooms",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "failed",
      reason: "send_failed",
      personName: "Nasira",
    });
  });

  it("never calls /api/anthropic for any matched fast-path delegation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const sendDelegationFn = vi.fn().mockResolvedValue("Sent.");

    await executeDelegationFastPath(
      "ask Nasira to prepare the guest bedrooms for arrival",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    const anthropicCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/anthropic"),
    );
    expect(anthropicCalls).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it("preserves 'Christopher' as recipient when instruction explicitly names him", async () => {
    const sendDelegationFn = vi.fn().mockResolvedValue("Done. I asked Christopher to make it.");

    const result = await executeDelegationFastPath(
      "ask Christopher to make these for lunch",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result.handled).toBe(true);
    expect((result as { personName?: string }).personName).toBe("Christopher");
    expect(sendDelegationFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Christopher" }),
    );
  });

  it("photo delegation with 'ask Christopher to make these' matches fast path even with 'these'", async () => {
    const sendDelegationFn = vi.fn().mockResolvedValue("Done. I asked Christopher to make these.");

    const result = await executeDelegationFastPath(
      "ask Christopher to make these for lunch tomorrow",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error("handled expected");
    expect(result.status).toBe("sent");
    // Result must not contain failure wording
    expect(result.response).not.toMatch(/couldn.t|wasn.t able|try again/i);
  });

  it("does not contain 'one moment' or 'please wait' in any response string", async () => {
    const sendDelegationFn = vi.fn().mockResolvedValue("Done.");
    const result = await executeDelegationFastPath(
      "ask Nasira to clean the bedrooms",
      { people: roster(), userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );
    if (result.handled && result.status === "sent") {
      expect(result.response).not.toMatch(/one moment|please wait|hold on|just a second/i);
    }
  });
});
