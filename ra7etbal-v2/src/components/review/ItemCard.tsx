import { useId, type CSSProperties } from "react";
import type { Assignment, ExtractedItem, ItemType } from "../../types/extraction";
import type { Person } from "../../types/person";

interface Props {
  item: ExtractedItem;
  people: Person[];
  onAssign: (itemId: string, assignedTo: Assignment) => void;
  onDescriptionChange: (itemId: string, description: string) => void;
  onMessageChange: (itemId: string, suggestedMessage: string | null) => void;
}

/** Visual treatment per type — colour cue + label. */
const TYPE_META: Record<ItemType, { label: string; cls: string }> = {
  action: { label: "Action", cls: "bg-sage/15 text-sage border-sage/30" },
  reminder: { label: "Reminder", cls: "bg-amber-100 text-amber-900 border-amber-300" },
  message: { label: "Message", cls: "bg-sky-100 text-sky-900 border-sky-300" },
  delegation: { label: "Delegation", cls: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  decision: { label: "Decision", cls: "bg-violet-100 text-violet-900 border-violet-300" },
  followup: { label: "Follow-up", cls: "bg-rose-100 text-rose-900 border-rose-300" },
  errand: { label: "Errand", cls: "bg-teal-100 text-teal-900 border-teal-300" },
  parked: { label: "Parked", cls: "bg-stone-100 text-stone-700 border-stone-300" },
};

// `field-sizing: content` lets modern browsers (iOS 17+, Chrome 123+) grow the
// textarea with the text. Older browsers fall back to native scroll within rows.
const autoGrow: CSSProperties = { fieldSizing: "content" } as CSSProperties;

export default function ItemCard({
  item,
  people,
  onAssign,
  onDescriptionChange,
  onMessageChange,
}: Props) {
  const type = TYPE_META[item.type];
  const descId = useId();
  const msgId = useId();

  const currentValue =
    item.assignedTo === null ? "" : item.assignedTo === "__me__" ? "__me__" : item.assignedTo;

  const assignedToInList =
    !item.assignedTo ||
    item.assignedTo === "__me__" ||
    people.some((p) => p.name === item.assignedTo);

  const showsAssignment = item.type !== "parked" && item.type !== "decision";
  // Messages and delegations are the two types where a recipient-facing
  // message makes sense. Other types can still have one if the AI suggested it.
  const messageRelevant =
    item.type === "message" || item.type === "delegation" || item.suggestedMessage != null;

  return (
    <article className="rounded-2xl border border-sage/30 bg-white/80 p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <span
          className={
            "rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide " +
            type.cls
          }
        >
          {type.label}
        </span>
        {item.needsPerson && (
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900">
            Needs person
          </span>
        )}
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
        placeholder="Describe the task…"
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
            placeholder="Write the message to send…"
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
            <option value="">— Unassigned —</option>
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
