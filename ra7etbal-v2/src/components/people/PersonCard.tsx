import type { Person } from "../../types/person";

interface Props {
  person: Person;
  onEdit: (person: Person) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export default function PersonCard({ person, onEdit }: Props) {
  return (
    <button
      type="button"
      onClick={() => onEdit(person)}
      className="flex w-full items-center gap-3 rounded-2xl border border-sage/30 bg-white/80 px-4 py-3 text-left shadow-sm transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-sage/40"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sage/15 text-sm font-semibold text-sage">
        {initials(person.name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium text-ink">{person.name}</span>
        {person.role && <span className="truncate text-xs text-ink/55">{person.role}</span>}
        {person.phone && (
          <span className="truncate font-mono text-[11px] text-ink/38">
            {person.phone}
          </span>
        )}
      </span>
      <span aria-hidden className="text-ink/30">›</span>
    </button>
  );
}
