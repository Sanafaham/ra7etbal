import { useId, useRef, useState, type FormEvent } from "react";
import AuthNotice from "../auth/AuthNotice";
import Spinner from "../Spinner";
import type { Person, PersonDraft } from "../../types/person";

const ROLE_SUGGESTIONS = [
  "Driver",
  "Nanny",
  "Cook",
  "Cleaner",
  "Personal Assistant",
  "House Manager",
  "Gardener",
  "Helper",
  "Tutor",
  "Family",
];

interface Props {
  /** When editing, pass the existing row; when creating, omit. */
  initial?: Person;
  /** Returns the draft to save. Throwing/rejecting keeps the form open and surfaces the error. */
  onSubmit: (draft: PersonDraft) => Promise<unknown>;
  onCancel: () => void;
  /** Optional delete handler — only shown when editing. */
  onDelete?: () => Promise<unknown>;
}

export default function PersonForm({ initial, onSubmit, onCancel, onDelete }: Props) {
  const nameId = useId();
  const roleId = useId();
  const phoneId = useId();
  const notesId = useId();
  const roleListId = useId();

  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const [busy, setBusy] = useState<null | "save" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const busyRef = useRef(false);

  const trimmedName = name.trim();
  const trimmedRole = role.trim();
  const canSave = !busy && trimmedName.length > 0 && trimmedRole.length > 0;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busyRef.current || !canSave) return;
    busyRef.current = true;
    setBusy("save");
    setError(null);
    try {
      await onSubmit({
        name: trimmedName,
        role: trimmedRole,
        phone: phone.trim() ? phone.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Please try again.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!onDelete || busyRef.current) return;
    busyRef.current = true;
    setBusy("delete");
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete. Please try again.");
      busyRef.current = false;
      setBusy(null);
    }
    // On success the parent closes the modal, no need to clear busy.
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-xs font-medium uppercase tracking-wide text-ink/60">
          Name
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ghulam"
          autoComplete="off"
          disabled={!!busy}
          className="w-full rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={roleId} className="text-xs font-medium uppercase tracking-wide text-ink/60">
          Role
        </label>
        <input
          id={roleId}
          list={roleListId}
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. Driver"
          autoComplete="off"
          disabled={!!busy}
          className="w-full rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
        <datalist id={roleListId}>
          {ROLE_SUGGESTIONS.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={phoneId} className="text-xs font-medium uppercase tracking-wide text-ink/60">
          Phone <span className="font-normal normal-case text-ink/40">(optional)</span>
        </label>
        <input
          id={phoneId}
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+971 50 000 0000"
          autoComplete="tel"
          inputMode="tel"
          disabled={!!busy}
          className="w-full rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={notesId} className="text-xs font-medium uppercase tracking-wide text-ink/60">
          Carson memory <span className="font-normal normal-case text-ink/40">(optional)</span>
        </label>
        <textarea
          id={notesId}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Reliable and punctual; prefers clear instructions."
          rows={3}
          disabled={!!busy}
          className="w-full resize-none rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
        <p className="text-xs leading-relaxed text-ink/45">
          Durable context only: communication style, reliability, and follow-up preferences.
        </p>
      </div>

      {error && <AuthNotice kind="error">{error}</AuthNotice>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onDelete && !confirmingDelete && (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={!!busy}
            className="mr-auto rounded-full border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
          >
            Delete
          </button>
        )}
        {onDelete && confirmingDelete && (
          <div className="mr-auto flex items-center gap-2">
            <span className="text-xs text-ink/70">Are you sure?</span>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={!!busy}
              className="rounded-full border border-sage/30 bg-white px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-cream disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!!busy}
              className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
            >
              {busy === "delete" && <Spinner size={12} />}
              {busy === "delete" ? "Deleting…" : "Delete"}
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={onCancel}
          disabled={!!busy}
          className="rounded-full border border-sage/30 bg-white px-5 py-2.5 text-sm font-medium text-ink shadow-sm transition hover:bg-cream disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          aria-busy={busy === "save"}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-sage px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "save" && <Spinner size={14} />}
          <span>{busy === "save" ? "Saving…" : initial ? "Save changes" : "Add person"}</span>
        </button>
      </div>
    </form>
  );
}
