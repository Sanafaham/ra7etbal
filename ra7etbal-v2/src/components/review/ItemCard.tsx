import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { Assignment, ExtractedItem, ItemType } from "../../types/extraction";
import { reviewDisplayLabel } from "../../lib/review-selection";
import type { Person } from "../../types/person";

interface Props {
  item: ExtractedItem;
  people: Person[];
  onAssign: (itemId: string, assignedTo: Assignment) => void;
  onDescriptionChange: (itemId: string, description: string) => void;
  onMessageChange: (itemId: string, suggestedMessage: string | null) => void;
  onImageChange: (itemId: string, file: File | null) => void;
  onRemove: (itemId: string) => void;
}

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

const autoGrow: CSSProperties = { fieldSizing: "content" } as CSSProperties;

export default function ItemCard({
  item,
  people,
  onAssign,
  onDescriptionChange,
  onMessageChange,
  onImageChange,
  onRemove,
}: Props) {
  const type = TYPE_META[item.type];
  const descId = useId();
  const msgId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item.imageFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(item.imageFile);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [item.imageFile]);

  const currentValue =
    item.assignedTo === null ? "" : item.assignedTo === "__me__" ? "__me__" : item.assignedTo;

  const assignedToInList =
    !item.assignedTo ||
    item.assignedTo === "__me__" ||
    people.some((p) => p.name === item.assignedTo);

  const showsAssignment = item.type !== "parked" && item.type !== "decision" && item.type !== "todo";
  const messageRelevant =
    item.type === "message" || item.type === "delegation" || item.suggestedMessage != null;

  return (
    <article className="rounded-2xl border border-sage/30 bg-white/80 p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              "rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide " +
              type.cls
            }
          >
            {reviewDisplayLabel(item.type)}
          </span>
          {item.needsPerson && (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900">
              Needs person
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          aria-label={`Remove "${item.description || "this item"}" from review`}
          title="Remove from review"
          className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 shadow-sm transition hover:bg-rose-100"
        >
          <span aria-hidden>×</span> Remove
        </button>
      </header>

      <label htmlFor={descId} className="sr-only">
        Task title
      </label>
      <textarea
        id={descId}
        value={item.description}
        onChange={(e) => onDescriptionChange(item.id, e.target.value)}
        rows={1}
        spellCheck
        aria-label="Task title"
        style={autoGrow}
        className="mt-3 block w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1 text-base leading-snug text-ink outline-none transition placeholder:text-ink/35 hover:border-sage/15 hover:bg-cream/30 focus:border-sage/40 focus:bg-white focus:ring-2 focus:ring-sage/20"
        placeholder="Describe the task..."
      />

      {messageRelevant && (
        <>
          <label
            htmlFor={msgId}
            className="mt-3 block text-[10px] font-medium uppercase tracking-wide text-ink/50"
          >
            Message to send
          </label>
          <textarea
            id={msgId}
            value={item.suggestedMessage ?? ""}
            onChange={(e) => onMessageChange(item.id, e.target.value)}
            rows={2}
            spellCheck
            style={autoGrow}
            placeholder="Write the message to send..."
            className="mt-1 block w-full resize-none rounded-lg border border-sage/20 bg-cream/40 px-3 py-2 text-sm italic leading-snug text-ink/85 outline-none transition placeholder:not-italic placeholder:text-ink/35 hover:bg-cream/60 focus:border-sage/40 focus:bg-white focus:ring-2 focus:ring-sage/20"
          />
          {item.type === "delegation" && (
            <p className="mt-1 text-[11px] text-ink/45">
              Confirmation link will be added after saving.
            </p>
          )}
        </>
      )}

      {item.clarificationQuestion && (
        <p className="mt-2 text-xs text-amber-800">
          <span className="font-medium uppercase tracking-wide text-[10px]">Note:</span>{" "}
          {item.clarificationQuestion}
        </p>
      )}

      {item.type === "reminder" && (item.dueText || item.dueAt) && (
        <p className="mt-2 text-xs text-amber-900">
          <span className="font-medium uppercase tracking-wide text-[10px]">Due:</span>{" "}
          {item.dueText ?? formatDue(item.dueAt)}
        </p>
      )}

      {showsAssignment && (
        <div className="mt-3 flex flex-col gap-1.5">
          <label className="text-[10px] font-medium uppercase tracking-wide text-ink/50">
            Assign to
          </label>
          <select
            value={currentValue}
            onChange={(e) => {
              const v = e.target.value;
              onAssign(item.id, v === "" ? null : v);
            }}
            className="w-full rounded-xl border border-sage/30 bg-white px-3 py-2 text-sm text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30"
          >
            <option value="">Unassigned</option>
            <option value="__me__">Me</option>
            {people.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name} · {p.role}
              </option>
            ))}
            {!assignedToInList && item.assignedTo && (
              <option value={item.assignedTo}>{item.assignedTo} (not in People)</option>
            )}
          </select>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {previewUrl ? (
          <div className="relative inline-block">
            <img
              src={previewUrl}
              alt="Attached"
              className="h-20 w-20 rounded-xl border border-sage/20 object-cover shadow-sm"
            />
            {(item.imageFiles?.length ?? 0) > 1 && (
              <span className="absolute bottom-1 right-1 rounded-full bg-ink/75 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                {item.imageFiles!.length} photos
              </span>
            )}
            <button
              type="button"
              aria-label="Remove image"
              onClick={() => onImageChange(item.id, null)}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white shadow"
            >
              ×
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-full border border-sage/30 bg-white/70 px-3 py-1.5 text-xs font-medium text-ink/60 shadow-sm transition hover:bg-white hover:text-ink"
          >
            Attach photo
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            onImageChange(item.id, file);
            e.target.value = "";
          }}
        />
      </div>
    </article>
  );
}

function formatDue(value: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
