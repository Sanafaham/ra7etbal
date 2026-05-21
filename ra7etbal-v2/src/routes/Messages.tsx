import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import MessageCard from "../components/messages/MessageCard";
import RefreshButton from "../components/RefreshButton";
import Spinner from "../components/Spinner";
import { useTaskList } from "../hooks/useTaskList";
import { useMessagesStore } from "../stores/messages";
import { usePeopleStore } from "../stores/people";
import type { Message } from "../types/message";

export default function Messages() {
  const { userId, tasks, messages, messagesStatus, messagesError, reload } = useTaskList();
  const [showConfirmed, setShowConfirmed] = useState(false);
  const { people, loadedForUserId: peopleLoadedForUserId, loadPeople } =
    usePeopleStore(
      useShallow((s) => ({
        people: s.items,
        loadedForUserId: s.loadedForUserId,
        loadPeople: s.loadFor,
      })),
    );

  useEffect(() => {
    if (!userId) return;
    if (peopleLoadedForUserId !== userId) void loadPeople(userId);
  }, [userId, peopleLoadedForUserId, loadPeople]);

  // Quick task lookup so each MessageCard can render Waiting / Confirmed.
  const taskById = useMemo(() => {
    const m = new Map<string, { status: string; confirmed_at: string | null }>();
    for (const t of tasks) {
      m.set(t.id, { status: t.status, confirmed_at: t.confirmed_at });
    }
    return m;
  }, [tasks]);

  const { waiting, confirmed, standalone } = useMemo(() => {
    const w: Message[] = [];
    const c: Message[] = [];
    const s: Message[] = [];
    for (const msg of messages) {
      if (!msg.task_id) {
        s.push(msg);
        continue;
      }
      const t = taskById.get(msg.task_id);
      if (t?.status === "done") c.push(msg);
      else w.push(msg);
    }
    return { waiting: w, confirmed: c, standalone: s };
  }, [messages, taskById]);

  const phoneByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const person of people) {
      const key = person.name.trim().toLowerCase();
      if (key && person.phone) m.set(key, person.phone);
    }
    return m;
  }, [people]);

  async function handleDelete(msg: Message) {
    if (!window.confirm("Delete this message?")) return;
    try {
      await useMessagesStore.getState().remove(msg.id);
    } catch (e) {
      console.error(e);
    }
  }

  const initialLoading = messagesStatus === "loading" && messages.length === 0;

  function renderList(msgs: Message[]) {
    return (
      <ul className="space-y-3">
        {msgs.map((m) => (
          <li key={m.id}>
            <MessageCard
              message={m}
              linkedTask={m.task_id ? taskById.get(m.task_id) ?? null : null}
              recipientPhone={
                phoneByName.get(m.recipient.trim().toLowerCase()) ?? null
              }
              onDelete={handleDelete}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Messages</h1>
          <p className="text-sm text-ink/60">
            Prepared messages waiting to be sent.
          </p>
        </div>
        <RefreshButton onClick={reload} />
      </header>

      {messagesError && messagesStatus !== "loading" && (
        <AuthNotice kind="error">
          {messagesError}{" "}
          <button type="button" onClick={() => void reload()} className="ml-1 underline">
            Try again
          </button>
        </AuthNotice>
      )}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading messages" />
        </div>
      )}

      {!initialLoading && messages.length === 0 && messagesStatus === "ready" && (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-8 text-center text-sm text-ink/70">
          No messages yet. They'll appear here after you save them from Review.
        </div>
      )}

      {waiting.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink/55">
            Waiting on confirmation · {waiting.length}
          </h2>
          {renderList(waiting)}
        </section>
      )}

      {standalone.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink/55">
            Messages to send · {standalone.length}
          </h2>
          {renderList(standalone)}
        </section>
      )}

      {confirmed.length > 0 && (
        <section className="space-y-3">
          <button
            type="button"
            onClick={() => setShowConfirmed((v) => !v)}
            aria-expanded={showConfirmed}
            className="flex w-full items-center justify-between text-xs font-medium uppercase tracking-wide text-ink/55"
          >
            <span>Confirmed · {confirmed.length}</span>
            <span aria-hidden className="text-base">
              {showConfirmed ? "▾" : "▸"}
            </span>
          </button>
          {showConfirmed && renderList(confirmed)}
        </section>
      )}
    </section>
  );
}
