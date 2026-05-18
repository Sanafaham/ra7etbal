import type { Assignment, ExtractedItem, ItemType } from "../../types/extraction";
import type { Person } from "../../types/person";

interface Props {
  item: ExtractedItem;
  people: Person[];
  onAssign: (itemId: string, assignedTo: Assignment) => void;
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

export default function ItemCard({ item, people, onAssign }: Props) {
  const type = TYPE_META[item.type];

  // The current selected value as displayed in the <select>.
  const currentValue =
    item.assignedTo === null ? "" : item.assignedTo === "__me__" ? "__me__" : item.assignedTo;

  // If the AI assigned a name that's not in the current People list, surface it
  // as an "Other" option so it doesn't silently get dropped.
  const assignedToInList =
    !item.assignedTo ||
    item.assignedTo === "__me__" ||
    people.some((p) => p.name === item.assignedTo);

  const showsAssignment = item.type !== "parked" && item.type !== "decision";

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

      <p className="mt-3 text-base leading-snug text-ink">{item.description}</p>

      {item.suggestedMessage && (
        <p className="mt-2 rounded-lg border border-sage/20 bg-cream/60 px-3 py-2 text-sm italic text-ink/80">
          “{item.suggestedMessage}”
        </p>
      )}

      {item.clarificationQuestion && (
        <p className="mt-2 text-xs text-amber-800">
          {item.clarificationQuestion}
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
              <option value={item.assignedTo}>
                {item.assignedTo} (not in People)
              </option>
            )}
          </select>
        </div>
      )}
    </article>
  );
}
