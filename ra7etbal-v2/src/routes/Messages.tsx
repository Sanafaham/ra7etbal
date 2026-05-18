import AuthNotice from "../components/auth/AuthNotice";
import MessageCard from "../components/messages/MessageCard";
import Spinner from "../components/Spinner";
import { useTaskList } from "../hooks/useTaskList";
import { useMessagesStore } from "../stores/messages";
import type { Message } from "../types/message";

export default function Messages() {
  const { messages, messagesStatus, messagesError, reload } = useTaskList();

  async function handleDelete(msg: Message) {
    if (!window.confirm("Delete this message?")) return;
    try {
      await useMessagesStore.getState().remove(msg.id);
    } catch (e) {
      console.error(e);
    }
  }

  const initialLoading = messagesStatus === "loading" && messages.length === 0;

  return (
    <section className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Messages</h1>
        <p className="text-sm text-ink/60">
          Things to say. Copy and send through your usual channel.
        </p>
      </header>

      {messagesError && messagesStatus !== "loading" && (
        <AuthNotice kind="error">
          {messagesError}{" "}
          <button type="button" onClick={reload} className="ml-1 underline">
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

      {messages.length > 0 && (
        <ul className="space-y-3">
          {messages.map((m) => (
            <li key={m.id}>
              <MessageCard message={m} onDelete={handleDelete} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
