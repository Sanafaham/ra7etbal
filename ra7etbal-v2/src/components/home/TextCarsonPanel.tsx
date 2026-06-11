import { useEffect, useRef, useState } from "react";
import Spinner from "../Spinner";
import { askTextCarson, executeDelegationFromText, type TextCarsonContext } from "../../lib/text-carson";
import { saveInboxItem } from "../../lib/inbox";

interface Props {
  context: TextCarsonContext;
  hideHeading?: boolean;
  /**
   * When true, renders without the outer card wrapper (section + border + bg).
   * Use when embedding inside another card, e.g. the unified Carson card.
   * Implies hideHeading.
   */
  embedded?: boolean;
  /** Called when the user's input is a delegation/message request that must
   *  be routed to Clear My Head. Receives the raw input text. */
  onPrefill?: (text: string) => void;
}

export default function TextCarsonPanel({ context, hideHeading = false, embedded = false, onPrefill: _onPrefill }: Props) {
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "error" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Image attachment state
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep preview URL in sync with selected file; revoke on cleanup.
  useEffect(() => {
    if (!imageFile) { setImagePreviewUrl(null); return; }
    const url = URL.createObjectURL(imageFile);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

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
        const response = await executeDelegationFromText(trimmed, {
          ...context,
          imageFile: imageFile ?? null,
        });
        setAnswer(response);
        setInput("");
        setImageFile(null); // clear image after successful delegation send
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

  const showHeading = !hideHeading && !embedded;

  const content = (
    <>
      {showHeading && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text">Carson</h2>
          </div>
        </div>
      )}

      {/* Image preview — shown when a photo is attached */}
      {imagePreviewUrl && (
        <div className="mb-2 flex items-center gap-2">
          <div className="relative inline-block">
            <img
              src={imagePreviewUrl}
              alt="Attached image"
              className="h-14 w-14 rounded-xl border border-sage/25 object-cover shadow-sm"
            />
            <button
              type="button"
              onClick={() => setImageFile(null)}
              disabled={loading}
              aria-label="Remove attached image"
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink/70 text-white shadow transition hover:bg-ink disabled:opacity-50"
            >
              <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
              </svg>
            </button>
          </div>
          <p className="text-[11px] text-ink/50">Photo attached</p>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {/* Image attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          aria-label="Attach image"
          title="Attach image"
          className={
            "inline-flex min-h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border transition disabled:opacity-50 " +
            (imageFile
              ? "border-sage/50 bg-sage/10 text-sage"
              : "border-sage/25 bg-white text-ink/40 hover:border-sage/40 hover:text-ink/60")
          }
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            setImageFile(file);
            e.target.value = ""; // allow reselecting the same file
          }}
          className="sr-only"
          aria-label="Attach image"
        />
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
          placeholder="Type what you want Carson to handle…"
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
            {looksLikeStatusSummary(answer) ? (
              <span className="text-[11px] text-text-muted">Already tracked in Ra7etBal.</span>
            ) : (
              <button
                type="button"
                onClick={() => { void handleSaveToInbox(); }}
                disabled={saving || saveStatus === "saved"}
                className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-sage/30 bg-white px-3 text-[12px] font-medium text-text shadow-sm transition hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving && <Spinner size={11} />}
                <span>{saveStatus === "saved" ? "Saved ✓" : "Save to Inbox"}</span>
              </button>
            )}
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
    </>
  );

  if (embedded) {
    return <div className="mt-3 border-t border-sage/15 pt-3">{content}</div>;
  }

  return (
    <section className="mt-3 rounded-[24px] border border-sage/25 bg-white/72 p-4 shadow-sm backdrop-blur-sm">
      {content}
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
/**
 * Returns true when a Carson response is a status/tracking summary that
 * duplicates information already stored in Ra7etBal (tasks, reminders,
 * delegations, waiting-on, daily brief). These should not be saved to Inbox
 * because they are read-outs of data that already exists.
 *
 * Returns false for plans, advice, ideas, notes, brainstorms, and any
 * content the user might genuinely want to capture.
 *
 * Conservative: false negatives (allowing a borderline save) are preferable
 * to false positives (blocking a legitimate save).
 */
function looksLikeStatusSummary(text: string): boolean {
  const t = text.toLowerCase();

  // Reminder/task lists — "you have X reminder(s)", "X reminders today"
  if (/\byou (?:have|had) \d+ reminder/.test(t)) return true;
  if (/\b\d+ reminder/.test(t) && /\btoday\b|\boverdue\b|\bdue\b/.test(t)) return true;
  if (/\byour reminder[s:]/.test(t)) return true;
  if (/\byour reminder about\b/.test(t)) return true;

  // Status / clear-state sentences
  if (/\byou'?re clear\b/.test(t)) return true;
  if (/\bno (?:open )?tasks?\b.*\bno (?:open )?reminders?\b/.test(t)) return true;
  if (/\bnothing (?:is |to )?pending\b/.test(t)) return true;
  if (/\bno pending\b/.test(t)) return true;
  if (/\beverything is on track\b/.test(t)) return true;
  if (/\bnothing needs your (?:direct )?action\b/.test(t)) return true;
  if (/\bno open tasks?,? overdue items?,? or (?:active )?bottlenecks?\b/.test(t)) return true;

  // "Needs attention" summaries
  if (/\bneeds? (?:your )?attention\b/.test(t) && /\btoday\b|\bright now\b/.test(t)) return true;
  if (/\b\d+ items? (?:that )?need(?:s)? (?:your )?attention\b/.test(t)) return true;

  // Waiting-on / delegation status
  if (/\b(?:still )?waiting on \w+/.test(t)) return true;
  if (/\bwaiting on \d+ people\b/.test(t)) return true;
  if (/\b\d+ items? (?:is |are )?waiting on others\b/.test(t)) return true;
  if (/\bpending confirmation\b/.test(t)) return true;
  if (/\bhasn'?t confirmed\b/.test(t)) return true;

  // Morning/daily brief openings
  if (/^good (?:morning|afternoon|evening)\b/.test(t)) return true;

  // Explicit task/action list descriptors
  if (/\bopen tasks?\b.*\boverdue\b/.test(t)) return true;
  if (/\bno open tasks?\b/.test(t)) return true;

  // Follow-up / message status
  if (/\bsent (?:a )?follow.?up to \w+\b/.test(t)) return true;
  if (/\bhas been messaged via whatsapp\b/.test(t)) return true;
  if (/\btask created for \w+\b/.test(t)) return true;
  if (/\breminder set\b/.test(t)) return true;

  // Routing / refusal messages — never worth saving
  if (/\buse clear my head\b/.test(t)) return true;
  if (/\bi can'?t (?:send|create|delegate|do) that from here\b/.test(t)) return true;
  if (/\bpaste your request there\b/.test(t)) return true;
  if (/\bgot it.{0,30}saved to your inbox\b/.test(t)) return true;
  if (/\bcopied that to clear my head\b/.test(t)) return true;

  return false;
}

function looksLikeDelegationOrMessage(input: string): boolean {
  return (
    // "ask Grace to ...", "tell Grace to ...", "have Grace ...", "get Grace to ..."
    // Negative lookahead excludes "me" so "ask me to ..." is not caught.
    /\b(?:ask|tell|have|get)\s+(?!me\b)\w+\s+to\s+/i.test(input) ||
    // "remind me ..." — any personal reminder request regardless of phrasing.
    // The narrow /remind\s+me\s+(?:to|about)/ missed time-prefixed phrases:
    //   "remind me in 5 minutes to X", "remind me at 6pm to X", etc.
    // Broadening to /remind\s+me\b/ catches all of them.
    /\bremind\s+me\b/i.test(input) ||
    // "remind Grace to ..." — but not "remind me to ..."
    /\bremind\s+(?!me\b)\w+\s+to\b/i.test(input) ||
    // "set a reminder", "create a reminder", "add a reminder"
    /\b(?:set|create|add)\s+(?:a\s+)?reminder\b/i.test(input) ||
    // "send Grace a message", "whatsapp Grace", "text Grace"
    // Excludes "send me" to avoid false-positive on "remind me" variants.
    /\b(?:send|whatsapp|text)\s+(?!me\b)\w+/i.test(input) ||
    // "message Grace about ..." — only when message is the first word
    /^message\s+\w+/i.test(input) ||
    // "delegate X to Grace"
    /\bdelegate\s+/i.test(input)
  );
}
