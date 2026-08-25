import { describe, expect, it } from "vitest";
import {
  reduceCarsonTranscriptTurn,
  type CarsonTranscriptTurnState,
} from "./carson-transcript-turn-state";

// Production evidence (2026-08-25, PR #331 acceptance failure):
// Turn 2 (send_delegation): agent_message eventId 137 at 14:13:14.402Z,
// mode_change->speaking at 14:13:14.872Z (470ms LATER).
// Turn 3 (create_reminder): agent_message eventId 269 at 14:13:26.458Z,
// mode_change->speaking at 14:13:26.950Z (492ms LATER).
// Both prove agent_message can arrive BEFORE speaking for tool-invoking
// turns — the inverse of the non-tool ordering PR #331 assumed was
// universal. This state machine must support both orderings.

function run(events: Array<{ type: "new_turn" } | { type: "speaking" } | { type: "agent_message"; text: string }>) {
  let state: CarsonTranscriptTurnState = "pending";
  let display: string | null | undefined;
  for (const event of events) {
    const result = reduceCarsonTranscriptTurn(state, event);
    state = result.state;
    if (result.display !== undefined) display = result.display;
  }
  return { state, display };
}

describe("reduceCarsonTranscriptTurn", () => {
  it("A. speaking -> agent_message: final display is the new real transcript", () => {
    const { display, state } = run([
      { type: "new_turn" },
      { type: "speaking" },
      { type: "agent_message", text: "Christopher has it." },
    ]);
    expect(display).toBe("Christopher has it.");
    expect(state).toBe("displayed");
  });

  it("B. agent_message -> speaking (production Sequence B, tool turns): final display is the new real transcript, NOT cleared", () => {
    const { display, state } = run([
      { type: "new_turn" },
      { type: "agent_message", text: "Christopher has it." },
      { type: "speaking" },
    ]);
    expect(display).toBe("Christopher has it.");
    expect(state).toBe("displayed");
  });

  it("C. new user turn begins while previous transcript is displayed: stale transcript is cleared once speaking starts for the new turn", () => {
    // Turn 1 fully displayed.
    let state: CarsonTranscriptTurnState = "pending";
    let r = reduceCarsonTranscriptTurn(state, { type: "speaking" });
    state = r.state;
    r = reduceCarsonTranscriptTurn(state, { type: "agent_message", text: "Turn 1 reply." });
    state = r.state;
    expect(state).toBe("displayed");

    // Turn 2 starts — stale text must not survive into turn 2's speaking boundary.
    r = reduceCarsonTranscriptTurn(state, { type: "new_turn" });
    state = r.state;
    expect(state).toBe("pending");
    r = reduceCarsonTranscriptTurn(state, { type: "speaking" });
    expect(r.display).toBe(null);
    expect(r.state).toBe("cleared");
  });

  it("D. repeated speaking transitions during the same logical turn never clear a real current-turn transcript", () => {
    let state: CarsonTranscriptTurnState = "pending";
    let r = reduceCarsonTranscriptTurn(state, { type: "agent_message", text: "Done — reminder set." });
    state = r.state;
    expect(state).toBe("displayed");

    // Multi-sentence TTS: several more speaking transitions for the SAME turn.
    for (let i = 0; i < 5; i++) {
      r = reduceCarsonTranscriptTurn(state, { type: "speaking" });
      state = r.state;
      expect(r.display).toBeUndefined(); // no display change at all — never re-clears
    }
    expect(state).toBe("displayed");
  });

  it("E. exact production Turn 2/3 event-class sequence: new_turn -> agent_message (text arrives first) -> speaking (470-492ms later) -> repeated speaking (multi-sentence trailing audio) yields the real transcript displayed, never blanked", () => {
    let state: CarsonTranscriptTurnState = "pending";
    const text = "Christopher has it.";
    let r = reduceCarsonTranscriptTurn(state, { type: "new_turn" });
    state = r.state;
    r = reduceCarsonTranscriptTurn(state, { type: "agent_message", text });
    state = r.state;
    expect(r.display).toBe(text);
    // The delayed speaking transition (470-492ms later in production).
    r = reduceCarsonTranscriptTurn(state, { type: "speaking" });
    state = r.state;
    expect(r.display).toBeUndefined();
    expect(state).toBe("displayed");
    // Any trailing speaking transitions for the same turn.
    r = reduceCarsonTranscriptTurn(state, { type: "speaking" });
    expect(r.display).toBeUndefined();
  });

  it("never emits a display value other than null or the exact agent_message text — no placeholder/generated text", () => {
    const pendingSpeaking = reduceCarsonTranscriptTurn("pending", { type: "speaking" });
    expect(pendingSpeaking.display).toBe(null);
    const agentMsg = reduceCarsonTranscriptTurn("pending", { type: "agent_message", text: "hello" });
    expect(agentMsg.display).toBe("hello");
  });

  it("new_turn always resets to pending regardless of prior state", () => {
    for (const prior of ["pending", "cleared", "displayed"] as const) {
      expect(reduceCarsonTranscriptTurn(prior, { type: "new_turn" }).state).toBe("pending");
    }
  });
});
