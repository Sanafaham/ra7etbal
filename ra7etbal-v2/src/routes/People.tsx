import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import PersonCard from "../components/people/PersonCard";
import PersonForm from "../components/people/PersonForm";
import Spinner from "../components/Spinner";
import Modal from "../components/ui/Modal";
import { useAuth } from "../hooks/useAuth";
import { usePeopleStore } from "../stores/people";
import type { Person, PersonDraft } from "../types/person";

export default function People() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const { status, items, error, loadedForUserId, loadFor, add, update, remove } =
    usePeopleStore(
      useShallow((s) => ({
        status: s.status,
        items: s.items,
        error: s.error,
        loadedForUserId: s.loadedForUserId,
        loadFor: s.loadFor,
        add: s.add,
        update: s.update,
        remove: s.remove,
      })),
    );

  // Load on first visit and whenever the signed-in user changes.
  useEffect(() => {
    if (!userId) return;
    if (loadedForUserId !== userId) {
      void loadFor(userId);
    }
  }, [userId, loadedForUserId, loadFor]);

  const [editing, setEditing] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);

  async function handleCreate(draft: PersonDraft) {
    await add(draft);
    setAdding(false);
  }

  async function handleUpdate(draft: PersonDraft) {
    if (!editing) return;
    await update(editing.id, draft);
    setEditing(null);
  }

  async function handleDelete() {
    if (!editing) return;
    await remove(editing.id);
    setEditing(null);
  }

  const showInitialLoading = status === "loading" && items.length === 0;
  const showEmpty = status === "ready" && items.length === 0;

  return (
    <section className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">People</h1>
          <p className="text-sm text-ink/60">
            The people Ra7etBal can delegate to on your behalf.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-sage px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105"
        >
          <span aria-hidden className="text-lg leading-none">＋</span>
          <span>Add person</span>
        </button>
      </header>

      {error && status !== "loading" && (
        <AuthNotice kind="error">
          {error}{" "}
          {userId && (
            <button
              type="button"
              onClick={() => void loadFor(userId, { force: true })}
              className="ml-1 underline"
            >
              Try again
            </button>
          )}
        </AuthNotice>
      )}

      {showInitialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading people" />
        </div>
      )}

      {showEmpty && (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-8 text-center">
          <p className="text-base font-medium text-ink">No people yet</p>
          <p className="mt-1 text-sm text-ink/60">
            Add the people who help around your home — driver, nanny, cook, assistant —
            so Ra7etBal can hand tasks to the right person.
          </p>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-sage px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105"
          >
            <span aria-hidden className="text-lg leading-none">＋</span>
            <span>Add your first person</span>
          </button>
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((p) => (
            <li key={p.id}>
              <PersonCard person={p} onEdit={setEditing} />
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a person"
      >
        <PersonForm onSubmit={handleCreate} onCancel={() => setAdding(false)} />
      </Modal>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.name}` : "Edit person"}
      >
        {editing && (
          <PersonForm
            initial={editing}
            onSubmit={handleUpdate}
            onCancel={() => setEditing(null)}
            onDelete={handleDelete}
          />
        )}
      </Modal>
    </section>
  );
}
