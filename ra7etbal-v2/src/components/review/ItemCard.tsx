import { useId, type CSSProperties } from "react";
import type { ExtractedItem, ItemType } from "../../types/extraction";
import { reviewDisplayLabel } from "../../lib/review-selection";

interface Props {
  item: ExtractedItem;
  onDescriptionChange: (itemId: string, description: string) => void;
  onRemove: (itemId: string) => void;
}

/**
 * Visual colour cue per type. Clear My Head is a temporary dump/review space
 * that never saves anything, so the badge TEXT must not read like a real
 * Carson-created object (see reviewDisplayLabel) — only the colour still
 * differentiates by type, for quick visual scanning.
 */
const TYPE_META: Record<ItemType, { cls: string }> = {
  action: { cls: "bg-sage/15 text-sage border-sage/30" },
  reminder: { cls: "bg-amber-100 text-amber-900 border-amber-300" },
  message: { cls: "bg-sky-100 text-sky-900 border-sky-300" },
  delegation: { cls: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  decision: { cls: "bg-violet-100 text-violet-900 border-violet-300" },
  followup: { cls: "bg-rose-100 text-rose-900 border-rose-300" },
  errand: { cls: "bg-teal-100 text-teal-900 border-teal-300" },
  parked: { cls: "bg-stone-100 text-stone-700 border-stone-300" },
  todo: { cls: "bg-lime-100 text-lime-900 border-lime-300" },
};

// `field-sizing: content` lets modern browsers (iOS 17+, Chrome 123+) grow the
// textarea with the text. Older browsers fall back to native scroll within rows.
const autoGrow: CSSProperties = { fieldSizing: "content" } as CSSProperties;

/**
 * Clear My Head Review card. Display-only: shows just the badge, the raw
 * thought text, and a way to remove it — no editable recipient, no editable
 * outgoing text, no scheduling, no attachments. Rendering those here made a
 * temporary, unsaved thought look like it had already been acted on. Voice
 * or text Carson is the only path that turns a kept thought into a real
 * saved record.
 */
export default function ItemCard({ item, onDescriptionChange, onRemove }: Props) {
  const type = TYPE_META[item.type];
  const descId = useId();

  return (
    <article className="rounded-2xl border border-sage/30 bg-white/80 p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <span
          className={
            "rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide " +
            type.cls
          }
        >
          {reviewDisplayLabel(item.type)}
        </span>
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          aria-label={`Remove "${item.description || "this item"}" from review`}
          title="Remove from review"
          className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 shadow-sm transition hover:bg-rose-100"
        >
          <span aria-hidden>✕</span> Remove
        </button>
      </header>

      <label htmlFor={descId} className="sr-only">
        Thought
      </label>
      <textarea
        id={descId}
        value={item.description}
        onChange={(e) => onDescriptionChange(item.id, e.target.value)}
        rows={1}
        spellCheck
        aria-label="Thought"
        style={autoGrow}
        className="mt-3 block w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1 text-base leading-snug text-ink outline-none transition placeholder:text-ink/35 hover:border-sage/15 hover:bg-cream/30 focus:border-sage/40 focus:bg-white focus:ring-2 focus:ring-sage/20"
        placeholder="What's on your mind…"
      />
    </article>
  );
}
