import type { TranscriptMessage } from "../../lib/carson-summarize";

/**
 * Voice bubble removal (owner decision 2026-10-09). After a voice call the
 * conversation is no longer shown as bubbles; the owner can open it on request
 * as a session text record. Pure view: it only displays the turns it is given,
 * writes nothing, and marks nothing surfaced.
 *
 * The text is what Carson showed for the call, which can differ from what was
 * spoken, so it is labelled as a session text record, never as an audio
 * transcript.
 */
export const VOICE_SESSION_TEXT_RECORD_ID = "carson-voice-session-text-record";
export const VOICE_SESSION_TEXT_RECORD_NOTE =
  "Session text record. This is the text shown for this call; Carson's spoken words may have differed.";

export default function CarsonVoiceSessionTextRecord({
  turns,
  shown,
  onToggle,
}: {
  turns: TranscriptMessage[];
  shown: boolean;
  onToggle: () => void;
}) {
  if (turns.length === 0) return null;
  return (
    <div className="mt-2 flex w-full max-w-[280px] flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={shown}
        aria-controls={VOICE_SESSION_TEXT_RECORD_ID}
        className="rounded-full border border-border bg-surface px-3 py-1 text-[11px] font-medium text-ink shadow-sm"
      >
        {shown ? "Hide transcript" : "Show transcript"}
      </button>
      {shown && (
        <section
          id={VOICE_SESSION_TEXT_RECORD_ID}
          aria-label="Session text record"
          className="flex max-h-[280px] w-full flex-col gap-1.5 overflow-y-auto"
        >
          <p className="px-2 text-[10px] leading-snug text-ink">{VOICE_SESSION_TEXT_RECORD_NOTE}</p>
          {turns.map((turn, index) =>
            turn.role === "user" ? (
              <p key={index} className="px-2 text-[11px] text-ink">
                Carson heard: “{turn.message}”
              </p>
            ) : (
              <div key={index} className="rounded-2xl border border-border bg-surface px-3.5 py-2.5 shadow-sm">
                <p className="text-[12px] leading-relaxed text-ink">{turn.message}</p>
              </div>
            ),
          )}
        </section>
      )}
    </div>
  );
}
