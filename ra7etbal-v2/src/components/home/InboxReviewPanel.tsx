/**
 * InboxReviewPanel — Inbox Review V1
 *
 * Shows unprocessed inbox_items captured via Text Carson (or future voice
 * capture). Collapses entirely when the inbox is empty.
 *
 * Actions per item:
 *   Remind me   — creates a real reminder task immediately using existing
 *                 infrastructure (createTask + scheduleReminderPush). Marks
 *                 the inbox item processed ONLY after the save succeeds.
 *   Delegate    — pre-fills Clear My Head; item stays unprocessed.
 *   Task        — pre-fills Clear My Head; item stays unprocessed.
 *   Keep        — collapses item for the session (local state only, no DB write).
 *   Dismiss     — marks processed_at immediately, item disappears.
 */

import { useEffect, useState } from "react";
import type { InboxItem } from "../../types/inbox";
import { listInboxItems, markInboxItemProcessed } from "../../lib/inbox";
import { createTask } from "../../lib/tasks";
import { scheduleReminderPush } from "../../lib/qstash-reminder";
import { parseVoiceTime } from "../../lib/parse-voice-time";
import { useBadgeStore } from "../../stores/badges";

interface Props {
  userId: string | null;
  /** Called when Delegate or Task is tapped — pre-fills Clear My Head. */
  onPrefill: (text: string) => void;
}

export default function InboxReviewPanel({ userId, onPrefill }: Props) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [successes, setSuccesses] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const setInboxCount = useBadgeStore((s) => s.setInboxCount);

  useEffect(() => {
    if (!userId) return;
    listInboxItems()
      .then((result) => { setItems(result); setInboxCount(result.length); })
      .catch(() => {/* panel stays hidden */})
      .finally(() => setLoaded(true));
  }, [userId, setInboxCount]);

  const visible = items.filter((item) => !kept.has(item.id));

  if (!loaded || visible.length === 0) return null;

  // ── Remind me ────────────────────────────────────────────────────────────
  async function handleRemindMe(item: InboxItem) {
    if (!userId) return;
    clearMessages(item.id);
    setSaving((prev) => new Set(prev).add(item.id));

    try {
      // Strip leading "to " so "to call Ahmed" → "call Ahmed".
      const withoutTo = item.content.replace(/^to\s+/i, "");

      // Extract due time and clean the description.
      const { description, timeLabel, dueAt } = extractReminderParts(withoutTo);

      const task = await createTask({
        user_id: userId,
        description,
        type: "reminder",
        assigned_to: null,
        status: "pending",
        needs_follow_up: false,
        confirmation_url: null,
        due_at: dueAt,
      });

      // Schedule QStash push notification — fire-and-log, never blocks save.
      if (dueAt) {
        void scheduleReminderPush(task.id, dueAt);
      }

      // Mark processed ONLY after reminder is saved.
      await markInboxItemProcessed(item.id);
      setItems((prev) => { const next = prev.filter((i) => i.id !== item.id); setInboxCount(next.length); return next; });

      const msg = timeLabel ? `Reminder set for ${timeLabel}.` : "Reminder saved.";
      setSuccesses((prev) => ({ ...prev, [item.id]: msg }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't create reminder. Please try again.";
      setErrors((prev) => ({ ...prev, [item.id]: msg }));
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  // ── Dismiss ──────────────────────────────────────────────────────────────
  async function handleDismiss(item: InboxItem) {
    clearMessages(item.id);
    setDismissing((prev) => new Set(prev).add(item.id));
    try {
      await markInboxItemProcessed(item.id);
      setItems((prev) => { const next = prev.filter((i) => i.id !== item.id); setInboxCount(next.length); return next; });
    } catch {
      // Leave item visible if dismiss fails.
    } finally {
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  // ── Prefill (Delegate / Task) ─────────────────────────────────────────────
  function handlePrefill(content: string) {
    // Strip leading "to " to avoid "Remind me to to call Ahmed" style doubles.
    const cleaned = content.replace(/^to\s+/i, "");
    onPrefill(cleaned);
  }

  function clearMessages(id: string) {
    setErrors((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setSuccesses((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  return (
    <section className="mt-3 rounded-[24px] border border-sage/25 bg-white/72 p-4 shadow-sm backdrop-blur-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gold/20 text-[11px] font-bold text-gold-dark">
          {visible.length}
        </span>
        <h2 className="text-sm font-semibold text-text">Inbox</h2>
        <p className="text-xs text-text-soft">Captured thoughts waiting for your decision</p>
      </div>

      <ul className="space-y-2">
        {visible.map((item) => (
          <li
            key={item.id}
            className="rounded-2xl border border-sage/15 bg-card/60 px-3 py-2.5"
          >
            <p className="mb-1 text-[14px] leading-snug text-text">{item.content}</p>
            <p className="mb-2.5 text-[11px] text-text-muted">{timeAgo(item.created_at)}</p>

            {errors[item.id] && (
              <p className="mb-2 rounded-xl border border-danger/20 bg-danger/5 px-2.5 py-1.5 text-xs text-danger">
                {errors[item.id]}
              </p>
            )}
            {successes[item.id] && (
              <p className="mb-2 rounded-xl border border-sage/20 bg-sage/10 px-2.5 py-1.5 text-xs text-text">
                {successes[item.id]}
              </p>
            )}

            <div className="flex flex-wrap gap-1.5">
              <ActionButton
                label={saving.has(item.id) ? "Saving…" : "Remind me"}
                disabled={saving.has(item.id)}
                onClick={() => void handleRemindMe(item)}
                variant="primary"
              />
              <ActionButton
                label="Delegate"
                onClick={() => handlePrefill(item.content)}
                variant="primary"
              />
              <ActionButton
                label="Task"
                onClick={() => handlePrefill(item.content)}
                variant="primary"
              />
              <ActionButton
                label="Keep"
                onClick={() => setKept((prev) => new Set(prev).add(item.id))}
                variant="ghost"
              />
              <ActionButton
                label={dismissing.has(item.id) ? "…" : "Dismiss"}
                disabled={dismissing.has(item.id)}
                onClick={() => void handleDismiss(item)}
                variant="danger"
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ActionButton({
  label,
  onClick,
  disabled = false,
  variant,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant: "primary" | "ghost" | "danger";
}) {
  const base = "rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-50";
  const styles = {
    primary: "border border-charcoal/15 bg-charcoal/90 text-ivory hover:bg-espresso",
    ghost: "border border-sage/20 bg-transparent text-text-soft hover:bg-sage/10",
    danger: "border border-danger/20 bg-transparent text-danger/70 hover:bg-danger/5",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${styles[variant]}`}
    >
      {label}
    </button>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract reminder description and due time from an inbox content string.
 * Strips the time phrase from the description text.
 *
 * "call Ahmed tomorrow morning"
 *   → { description: "call Ahmed", timeLabel: "tomorrow morning", dueAt: "<ISO>" }
 */
function extractReminderParts(text: string): {
  description: string;
  timeLabel: string | null;
  dueAt: string | null;
} {
  // Try to parse a time from the text — parseVoiceTime uses regex with \b so
  // it will find "tomorrow morning" inside "call Ahmed tomorrow morning".
  const result = parseVoiceTime(text);
  const dueAt = result.dueAt || null;

  if (!dueAt) {
    return { description: text.trim(), timeLabel: null, dueAt: null };
  }

  // Strip the matched time phrase from the description.
  // Apply patterns in specificity order (longer matches first).
  const { cleaned, label } = stripTimePhrase(text);
  return {
    description: cleaned || text.trim(),
    timeLabel: label,
    dueAt,
  };
}

type PhraseEntry = { re: RegExp; label: string | null };

const TIME_PHRASE_PATTERNS: PhraseEntry[] = [
  { re: /\btomorrow\s+morning\b/i,   label: "tomorrow morning" },
  { re: /\btomorrow\s+afternoon\b/i, label: "tomorrow afternoon" },
  { re: /\btomorrow\s+evening\b/i,   label: "tomorrow evening" },
  { re: /\bnext\s+week\b/i,          label: "next week" },
  { re: /\bnext\s+month\b/i,         label: "next month" },
  { re: /\bnext\s+year\b/i,          label: "next year" },
  { re: /\bnext\s+(?:sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat)\b/i, label: null },
  { re: /\blater\s+today\b/i,        label: "later today" },
  { re: /\bbefore\s+bed\b/i,         label: "before bed" },
  { re: /\btonight\b/i,              label: "tonight" },
  { re: /\btomorrow\b/i,             label: "tomorrow" },
  { re: /\bin\s+\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\b/i, label: null },
  { re: /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i, label: null },
  { re: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i, label: null },
];

function stripTimePhrase(text: string): { cleaned: string; label: string | null } {
  for (const { re, label } of TIME_PHRASE_PATTERNS) {
    const match = text.match(re);
    if (match) {
      const matchedText = match[0];
      const cleaned = text
        .replace(re, "")
        .replace(/\s+/g, " ")
        .replace(/[,\s]+$/, "")
        .trim();
      return { cleaned: cleaned || text.trim(), label: label ?? matchedText.toLowerCase() };
    }
  }
  return { cleaned: text.trim(), label: null };
}

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
