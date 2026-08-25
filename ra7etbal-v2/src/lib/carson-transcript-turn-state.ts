/**
 * Pure state machine for the Carson voice transcript bubble's per-turn
 * clear/display behavior.
 *
 * Production evidence (2026-08-25): ElevenLabs' event order between the
 * "speaking" mode change (audio) and the "agent_message" event (text) is
 * NOT universal. Non-tool turns observed speaking before agent_message.
 * Tool-invoking turns (send_delegation, create_reminder) proved the
 * opposite: agent_message arrived, then speaking fired 470-492ms later
 * (turn eventIds 137 and 269). A guard that only clears-once on "speaking"
 * cannot tell the difference between "clear the stale previous turn" and
 * "wipe the real transcript that already arrived for THIS turn" — it wiped
 * the real one, because nothing recorded that a real transcript had already
 * been displayed for the current turn.
 *
 * This machine tracks that explicitly instead of inferring it from event
 * order:
 *   pending   — new turn, nothing shown yet, stale text may still be
 *               displayed from the previous turn.
 *   cleared   — the stale previous-turn text has been blanked; no real
 *               text for this turn has arrived yet.
 *   displayed — a real transcript for this turn is showing. Once here, no
 *               "speaking" event may ever blank it again for this turn —
 *               only a new turn can leave this state.
 */
export type CarsonTranscriptTurnState = "pending" | "cleared" | "displayed";

export type CarsonTranscriptTurnEvent =
  | { type: "new_turn" }
  | { type: "speaking" }
  | { type: "agent_message"; text: string };

export interface CarsonTranscriptTurnResult {
  state: CarsonTranscriptTurnState;
  /** Present only when the displayed transcript should change this step. */
  display?: string | null;
}

export function reduceCarsonTranscriptTurn(
  state: CarsonTranscriptTurnState,
  event: CarsonTranscriptTurnEvent,
): CarsonTranscriptTurnResult {
  switch (event.type) {
    case "new_turn":
      return { state: "pending" };
    case "speaking":
      if (state === "pending") {
        return { state: "cleared", display: null };
      }
      return { state };
    case "agent_message":
      return { state: "displayed", display: event.text };
  }
}
