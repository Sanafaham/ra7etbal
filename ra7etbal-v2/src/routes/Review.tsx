import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import ItemCard from "../components/review/ItemCard";
import Spinner from "../components/Spinner";
import AuthNotice from "../components/auth/AuthNotice";
import { useAuth } from "../hooks/useAuth";
import { addImpliedOperationalResponsibilities } from "../lib/ai/role-precedence";
import { savePending } from "../lib/save";
import { sendWhatsAppTask } from "../lib/whatsapp";
import { useDraftStore } from "../stores/draft";
import { useExtractionStore } from "../stores/extraction";
import { useMessagesStore } from "../stores/messages";
import { usePeopleStore } from "../stores/people";
import { useProfileStore } from "../stores/profile";
import { useTasksStore } from "../stores/tasks";

/**
 * Review — shows AI-extracted items with editable assignments, descriptions,
 * and messages, then saves them to Supabase as tasks + messages on Save.
 */
export default function Review() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  // Used to rewrite owner pronouns in outgoing delegation messages at save time.
  const displayName = useProfileStore((s) => s.displayName);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const {
    status,
    items,
    sourceText,
    setAssignment,
    setDescription,
    setSuggestedMessage,
    setImageFile,
  } = useExtractionStore(
    useShallow((s) => ({
      status: s.status,
      items: s.items,
      sourceText: s.sourceText,
      setAssignment: s.setAssignment,
      setDescription: s.setDescription,
      setSuggestedMessage: s.setSuggestedMessage,
      setImageFile: s.setImageFile,
    })),
  );

  const { items: people, loadFor: loadPeople, loadedForUserId } = usePeopleStore(
    useShallow((s) => ({
      items: s.items,
      loadFor: s.loadFor,
      loadedForUserId: s.loadedForUserId,
    })),
  );

  // Ensure People are loaded so the Assign dropdown is populated.
  useEffect(() => {
    if (!userId) return;
    if (loadedForUserId !== userId) void loadPeople(userId);
  }, [userId, loadedForUserId, loadPeople]);

  const sendableChecks = useMemo(
    () => items.map(getReviewSendableCheck),
    [items],
  );
  const hasSendableMessages = sendableChecks.some((check) => check.isSendable);

  const phoneByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const person of people) {
      const key = person.name.trim().toLowerCase();
      if (key && person.phone) m.set(key, person.phone);
    }
    return m;
  }, [people]);

  // No extraction has run — user landed on /review directly. Send them home.
  if (status === "idle") {
    return <Navigate to="/" replace />;
  }

  if (status === "running") {
    return (
      <div className="flex items-center justify-center py-12 text-text-soft">
        <Spinner size={20} label="Organizing" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <section className="space-y-4">
        <AuthNotice kind="error">
          We couldn't organize what you wrote. Head back to Home and try again.
        </AuthNotice>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-full border border-border/85 bg-warm-white px-4 py-2 text-sm font-medium text-text shadow-sm transition hover:bg-card"
        >
          ← Back to Home
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold">
          Review
        </p>
        <h1 className="text-4xl font-semibold leading-tight text-text" style={{ fontFamily: "var(--font-display)" }}>Here's your plan.</h1>
        {items.length > 0 && (
          <p className="text-sm text-text-soft">
            {items.length === 1
              ? "I found 1 item for you to review."
              : `I found ${items.length} items for you to review.`}
          </p>
        )}
      </header>

      {sourceText && (
        <details className="rounded-[24px] border border-border/80 bg-card/70 p-3 text-sm text-text-soft">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-text-soft">
            What you wrote
          </summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{sourceText}</p>
        </details>
      )}

      {items.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-gold/30 bg-card/70 p-6 text-sm text-text-soft">
          Ra7etBal didn't find anything actionable in that. Head back and try
          rephrasing.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.id}>
              <ItemCard
                item={it}
                people={people}
                onAssign={setAssignment}
                onDescriptionChange={setDescription}
                onMessageChange={setSuggestedMessage}
                onImageChange={setImageFile}
              />
            </li>
          ))}
        </ul>
      )}

      {saveError && <AuthNotice kind="error">{saveError}</AuthNotice>}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/"
          className="rounded-full border border-border/85 bg-warm-white px-4 py-2 text-center text-sm font-medium text-text shadow-sm transition hover:bg-card"
        >
          ← Back to Home
        </Link>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            aria-busy={saving}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-charcoal px-5 py-3 text-base font-medium text-ivory shadow-sm transition hover:bg-espresso disabled:cursor-not-allowed disabled:bg-gold-soft/50 disabled:text-text-soft"
          >
            {saving && <Spinner size={16} />}
            <span>
              {saving
                ? hasSendableMessages
                  ? "Saving & sending…"
                  : "Saving…"
                : hasSendableMessages
                  ? "Save & Send Messages"
                  : "Save"}
            </span>
          </button>
        )}
      </div>
    </section>
  );

  async function handleSave() {
    if (savingRef.current) return;
    if (!items.length) return;
    if (!userId) {
      setSaveError("Not signed in.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const itemsToSave = addImpliedOperationalResponsibilities(items, people, sourceText);
      // Collect any per-item image files into a Map keyed by item id.
      const imageFiles = new Map<string, File>();
      for (const item of itemsToSave) {
        if (item.imageFile) imageFiles.set(item.id, item.imageFile);
      }
      const result = await savePending(itemsToSave, userId, displayName, people, imageFiles.size > 0 ? imageFiles : undefined);
      const sendableSavedMessages = result.messages.filter(
        (message) =>
          !!message.recipient.trim() &&
          !!message.content.trim(),
      );
      // Build a lookup so we can pass the Reference image path for each task.
      // Primary source: imagePathsByTaskId recorded at upload time (before DB
      // round-trips). Fallback: task.image_path from the DB response in case
      // a task was saved without going through the upload path.
      const taskImagePathById = new Map<string, string | null>(result.imagePathsByTaskId);
      for (const t of result.tasks) {
        if (!taskImagePathById.has(t.id)) {
          taskImagePathById.set(t.id, t.image_path ?? null);
        }
      }
      let sendError: string | null = null;

      if (hasSendableMessages && sendableSavedMessages.length === 0) {
        sendError = "WhatsApp send could not start";
      } else if (hasSendableMessages) {
        try {
          await Promise.all(
            sendableSavedMessages.map((message) =>
              sendWhatsAppTask({
                to: phoneByName.get(message.recipient.trim().toLowerCase()) ?? null,
                messageText: message.content,
                confirmationLink: message.confirmation_url,
                messageRecordId: message.id,
                taskId: message.task_id,
                recipientName: message.recipient,
                ownerName: displayName ?? null,
                imagePath: message.task_id ? (taskImagePathById.get(message.task_id) ?? null) : null,
              }),
            ),
          );
        } catch (err) {
          console.error("Review Save & Send WhatsApp failed:", err);
          sendError =
            err instanceof Error ? err.message : "Could not send WhatsApp message.";
        }
      }
      // Force-reload from Supabase so Actions/Messages/Follow-ups reflect the
      // canonical server state, not an optimistic local push. This is the
      // safety net against any row that didn't actually persist (RLS, missing
      // default, etc) — if the rows aren't visible on read, the user sees the
      // empty state immediately rather than a phantom optimistic card.
      await Promise.all([
        useTasksStore.getState().loadFor(userId, { force: true }),
        useMessagesStore.getState().loadFor(userId, { force: true }),
      ]);
      // Clear the draft and the extraction — the flow is done.
      useDraftStore.getState().clear();
      useExtractionStore.getState().clear();
      await stopSavingBeforeBlockingAlert();
      if (hasSendableMessages) {
        window.alert(
          sendError
            ? sendError === "WhatsApp send could not start"
              ? "Saved, but WhatsApp send could not start. You can retry from Messages."
              : `Saved, but WhatsApp send failed: ${sendError}. You can retry from Messages.`
            : "Saved and sent on WhatsApp.",
        );
        navigate("/messages", { replace: true });
      } else {
        navigate("/actions", { replace: true });
      }
    } catch (err) {
      // Surface the original message — Supabase errors are now propagated
      // (e.g. "null value in column ... violates not-null constraint").
      console.error("savePending failed:", err);
      setSaveError(
        err instanceof Error ? err.message : "Could not save. Please try again.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function stopSavingBeforeBlockingAlert() {
    savingRef.current = false;
    flushSync(() => {
      setSaving(false);
    });
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });
  }
}

interface ReviewSendableCheck {
  type: string | null;
  kind: string | null;
  category: string | null;
  assignedPerson: string | null;
  messageTextPresent: boolean;
  isPersonalReminder: boolean;
  isSendable: boolean;
}

function getReviewSendableCheck(item: unknown): ReviewSendableCheck {
  const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const type = readString(record.type);
  const kind = readString(record.kind);
  const category = readString(record.category);
  const assignedPerson =
    readString(record.assignedTo) ??
    readString(record.assigned_to) ??
    readString(record.assignee) ??
    readString(record.recipient) ??
    readString(record.recipientName);
  const messageText =
    readString(record.suggestedMessage) ??
    readString(record.message) ??
    readString(record.content) ??
    readString(record.body) ??
    readString(record.text);
  const normalizedType = (type ?? kind ?? category ?? "").toLowerCase();
  const normalizedAssignee = assignedPerson?.toLowerCase() ?? "";
  const hasRealAssignedPerson =
    !!assignedPerson &&
    normalizedAssignee !== "__me__" &&
    normalizedAssignee !== "me" &&
    normalizedAssignee !== "owner";
  const messageTextPresent = !!messageText;
  const isPersonalReminder =
    normalizedType === "reminder" &&
    (!hasRealAssignedPerson || normalizedAssignee === "__me__");

  return {
    type,
    kind,
    category,
    assignedPerson,
    messageTextPresent,
    isPersonalReminder,
    isSendable: hasRealAssignedPerson && messageTextPresent && !isPersonalReminder,
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
