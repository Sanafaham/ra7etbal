import { useState } from "react";
import Spinner from "../Spinner";
import { askTextCarson, type TextCarsonContext } from "../../lib/text-carson";

interface Props {
  context: TextCarsonContext;
  hideHeading?: boolean;
  /** Called when the user's input is a delegation/message request that must
   *  be routed to Clear My Head. Receives the raw input text. */
  onPrefill?: (text: string) => void;
}

export default function TextCarsonPanel({ context, hideHeading = false, onPrefill }: Props) {
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const trimmed = input.trim();
  const canAsk = trimmed.length > 0 && !loading;

  async function handleAsk() {
    if (!canAsk) return;

    // Intercept delegation / message requests before calling the AI.
    // Text Carson has no action engine — it cannot send WhatsApp messages,
    // delegate tasks, or create items. Routing to Clear My Head is the
    // only honest response. This check runs client-side so there is no
    // window in which the LLM can fabricate a false "done" reply.
    if (looksLikeDelegationOrMessage(trimmed)) {
      onPrefill?.(trimmed);
      setAnswer(
        onPrefill
          ? "I've copied that to Clear My Head above. Tap 'Clear My Head' to review and send it properly."
          : "I can't send that from here. Use Clear My Head — paste your request there and it will be prepared and sent correctly.",
      );
      setInput("");
      return;
    }

    setLoading(true);
    setError(null);
    try {
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
        <div className="mt-3 rounded-2xl border border-sage/15 bg-card/80 px-3 py-2.5 text-sm leading-relaxed text-text-soft whitespace-pre-wrap">
          {answer}
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
