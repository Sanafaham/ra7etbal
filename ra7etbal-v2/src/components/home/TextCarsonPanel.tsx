import { useState } from "react";
import Spinner from "../Spinner";
import { askTextCarson, executeDelegationFromText, type TextCarsonContext } from "../../lib/text-carson";
import { saveInboxItem } from "../../lib/inbox";

interface Props {
  context: TextCarsonContext;
  hideHeading?: boolean;
  /** Called when the user's input is a delegation/message request that must
   *  be routed to Clear My Head. Receives the raw input text. */
  onPrefill?: (text: string) => void;
}

export default function TextCarsonPanel({ context, hideHeading = false, onPrefill: _onPrefill }: Props) {
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "error" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const trimmed = input.trim();
  const canAsk = trimmed.length > 0 && !loading;

  async function handleAsk() {
    if (!canAsk) return;

    setLoading(true);
    setError(null);
    setSaveStatus(null);
    setSaveError(null);
    try {
      if (looksLikeDelegationOrMessage(trimmed)) {
        const response = await executeDelegationFromText(trimmed, context);
        setAnswer(response);
        setInput("");
        return;
      }

      const response = await askTextCarson(trimmed, context);
      setAnswer(response);
      setInput("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Carson couldn't answer. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveToInbox() {
    if (!answer || saving) return;
    if (!context.userId) {
      setSaveStatus("error");
      setSaveError("Not signed in.");
      return;
    }
    setSaving(true);
    setSaveStatus(null);
    setSaveError(null);
    try {
      await saveInboxItem({
        user_id: context.userId,
        content: answer,
        source: "text_carson_response",
      });
      setSaveStatus("saved");
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "Couldn't save to inbox.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-3 rounded-[24px] border border-sage/25 bg-white/72 p-4 shadow-sm backdrop-blur-sm">
      {!hideHeading && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text">Carson</h2>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleAsk();
            }
          }}
          disabled={loading}
          placeholder="Ask what needs attention, save an idea, or create a reminder."
          className="min-h-[44px] flex-1 rounded-full border border-sage/25 bg-white px-4 text-[14px] text-text outline-none transition placeholder:text-muted focus:border-sage disabled:opacity-70"
        />
        <button
          type="button"
          onClick={() => { void handleAsk(); }}
          disabled={!canAsk}
          aria-busy={loading}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-charcoal/15 bg-charcoal px-4 text-sm font-semibold text-ivory shadow-sm transition hover:bg-espresso disabled:cursor-not-allowed disabled:bg-gold-soft/50 disabled:text-text-soft"
        >
          {loading && <Spinner size={14} />}
          <span>{loading ? "Thinking..." : "Send"}</span>
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-2xl border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {answer && (
        <div className="mt-3 rounded-2xl border border-sage/15 bg-card/80 px-3 py-2.5">
          <p className="text-sm leading-relaxed text-text-soft whitespace-pre-wrap">{answer}</p>
          <div className="mt-2.5 flex items-center gap-2 border-t border-sage/10 pt-2">
            <button
              type="button"
              onClick={() => { void handleSaveToInbox(); }}
              disabled={saving || saveStatus === "saved"}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-sage/30 bg-white px-3 text-[12px] font-medium text-text shadow-sm transition hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <Spinner size={11} />}
              <span>{saveStatus === "saved" ? "Saved ✓" : "Save to Inbox"}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAnswer(null);
                setSaveStatus(null);
                setSaveError(null);
              }}
              className="inline-flex min-h-[32px] items-center rounded-full border border-sage/20 bg-transparent px-3 text-[12px] font-medium text-text-muted transition hover:bg-cream hover:text-text"
            >
              Clear
            </button>
            {saveStatus === "error" && saveError && (
              <p className="ml-1 text-[11px] text-danger">{saveError}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Returns true when the input is a delegation or message request that Text
 * Carson cannot execute. These are routed to Clear My Head before any AI
 * call so there is no chance of a false "done" response.
 *
 * Patterns matched:
 *   "ask/tell/have/get [person] to [action]"  — but NOT "ask/tell me to"
 *   "remind [person] to [action]"             — but NOT "remind me to"
 *   "send/whatsapp/text [person]"             — but NOT "send me"
 *   "message [person]" at start of input
 *   "delegate ..."
 */
function looksLikeDelegationOrMessage(input: string): boolean {
  return (
    // "ask Grace to ...", "tell Grace to ...", "have Grace ...", "get Grace to ..."
    // Negative lookahead excludes "me" so "ask me to ..." is not caught.
    /\b(?:ask|tell|have|get)\s+(?!me\b)\w+\s+to\s+/i.test(input) ||
    // "remind Grace to ..." — but not "remind me to ..."
    /\bremind\s+(?!me\b)\w+\s+to\b/i.test(input) ||
    // "send Grace a message", "whatsapp Grace", "text Grace"
    // Excludes "send me" to avoid false-positive on "remind me" variants.
    /\b(?:send|whatsapp|text)\s+(?!me\b)\w+/i.test(input) ||
    // "message Grace about ..." — only when message is the first word
    /^message\s+\w+/i.test(input) ||
    // "delegate X to Grace"
    /\bdelegate\s+/i.test(input)
  );
}
