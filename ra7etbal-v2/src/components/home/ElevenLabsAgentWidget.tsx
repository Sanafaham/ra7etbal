import { Conversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createMessage } from "../../lib/messages";
import { createTask, updateTaskConfirmationUrl } from "../../lib/tasks";
import { sendWhatsAppTask } from "../../lib/whatsapp";
import { useAuthStore } from "../../stores/auth";
import { usePeopleStore } from "../../stores/people";
import { useTasksStore } from "../../stores/tasks";

type CallStatus = "idle" | "connecting" | "connected" | "error";
type AgentMode = "listening" | "speaking";

// ---------------------------------------------------------------------------
// Smart follow-up helpers
// ---------------------------------------------------------------------------

/** Same criteria as isWaitingTask() in daily-brief.ts — not imported to avoid
 *  coupling the widget to brief logic. */
function isOpenWaitingTask(task: {
  archived_at: string | null;
  status: string;
  assigned_to: string | null;
  needs_follow_up: boolean;
  type: string;
}): boolean {
  if (task.archived_at !== null) return false;
  if (task.status === "done" || task.status === "cancelled") return false;
  if (task.needs_follow_up) return true;
  if (task.type === "delegation" && task.assigned_to) return true;
  if (task.type === "followup") return true;
  return false;
}

/** Strip leading action verbs so the topic reads naturally in a sentence.
 *  Mirrors cleanForWaiting() in daily-brief.ts. */
function topicFromDescription(description: string): string {
  const trimmed = description.trim().replace(/[.!?]+$/, "").trim();
  const cleaned = trimmed.replace(
    /^(Confirm|Ask|Tell|Remind|Have|Message|Send|Check|Follow up on|Follow up|Get)\s+/i,
    "",
  );
  const result = cleaned === trimmed ? trimmed : cleaned;
  // lower-case the first letter so it fits mid-sentence
  return result.charAt(0).toLowerCase() + result.slice(1);
}

/** Build the default follow-up message text from a task description. */
function buildFollowUpText(description: string): string {
  const topic = topicFromDescription(description);
  return `Following up on ${topic}. Let me know when done.`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ElevenLabsAgentWidget({
  briefStateText,
}: {
  briefStateText: string;
}) {
  const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID?.trim();

  const [status, setStatus] = useState<CallStatus>("idle");
  const [mode, setMode] = useState<AgentMode>("listening");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const conversationRef = useRef<Awaited<
    ReturnType<typeof Conversation.startSession>
  > | null>(null);

  /** Per-person send cooldown: personName.toLowerCase() → timestamp of last send */
  const lastSentRef = useRef<Map<string, number>>(new Map());

  // ------------------------------------------------------------------
  // Client tool: send_followup
  // ------------------------------------------------------------------
  const sendFollowup = useCallback(
    async ({
      name,
      message,
      allowNewFollowup = false,
    }: {
      name: string;
      message?: string;
      /** Set to true only after the user has explicitly confirmed they want to
       *  send a new follow-up even though no matching open task was found. */
      allowNewFollowup?: boolean;
    }): Promise<string> => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        return "I did not receive a person name. Ask the user who to follow up with.";
      }

      // 1. Ensure stores are loaded before lookups
      const authUserId = useAuthStore.getState().user?.id;
      if (authUserId) {
        const peopleState = usePeopleStore.getState();
        if (peopleState.status === "idle" || peopleState.items.length === 0) {
          await usePeopleStore.getState().loadFor(authUserId);
        }
        const tasksState = useTasksStore.getState();
        if (tasksState.status === "idle" || tasksState.items.length === 0) {
          await useTasksStore.getState().loadFor(authUserId);
        }
      }

      // 2. Resolve person from People store
      const people = usePeopleStore.getState().items;
      const person = people.find(
        (p) => p.name.trim().toLowerCase() === normalizedName.toLowerCase(),
      );
      if (!person) {
        return `I could not find "${normalizedName}" in your contacts. Ask the user to add them first.`;
      }
      if (!person.phone) {
        return `${person.name} does not have a phone number saved. Ask the user to add one in People settings.`;
      }

      // 3. Duplicate guard (30-second cooldown per person)
      const cooldownKey = normalizedName.toLowerCase();
      const lastSent = lastSentRef.current.get(cooldownKey) ?? 0;
      if (Date.now() - lastSent < 30_000) {
        return `I already sent ${person.name} a follow-up just now. Wait a moment before sending again.`;
      }

      // 4. Resolve message — either explicit from agent or derived from tasks
      let messageText = message?.trim() ?? "";
      let topicLabel = messageText || "";

      // Always compute open tasks — needed for both the no-message path and
      // the stale-task guard on the explicit-message path.
      const tasks = useTasksStore.getState().items;
      const openTasks = tasks.filter(
        (t) =>
          isOpenWaitingTask(t) &&
          (t.assigned_to ?? "").trim().toLowerCase() ===
            normalizedName.toLowerCase(),
      );

      if (!messageText) {
        // No message provided — derive from open tasks.
        if (openTasks.length === 0) {
          return `I could not find an open item for ${person.name}. Ask the user what to follow up about.`;
        }

        if (openTasks.length > 1) {
          const topics = openTasks
            .slice(0, 4)
            .map((t) => topicFromDescription(t.description))
            .join(", ");
          return `I found more than one open item for ${person.name}: ${topics}. Ask the user which one to follow up on.`;
        }

        // Exactly one open task — use it
        const singleTask = openTasks[0];
        messageText = buildFollowUpText(singleTask.description);
        topicLabel = topicFromDescription(singleTask.description);
      } else {
        // Explicit message provided — guard against sending about a task that
        // is no longer open (done, deleted, archived) unless the user confirmed.
        topicLabel = topicFromDescription(messageText);

        if (!allowNewFollowup) {
          const messageLower = messageText.toLowerCase();
          const matchingOpen = openTasks.find((t) =>
            t.description.toLowerCase().includes(messageLower) ||
            messageLower.includes(topicFromDescription(t.description).toLowerCase()),
          );

          if (!matchingOpen) {
            // No open task matches this topic — warn before sending.
            if (openTasks.length === 0) {
              return `I do not see any open items for ${person.name}. Ask the user if they still want to send a new follow-up.`;
            }
            return `I do not see "${topicLabel}" as an open item for ${person.name}. Ask the user if they still want to send a new follow-up.`;
          }
        }
      }

      // 5. Verify auth user id (already fetched above; guard for unauthenticated edge case)
      const userId = authUserId;
      if (!userId) {
        return "You are not signed in. Please sign in and try again.";
      }

      // 6. Create follow-up task row
      let task;
      try {
        task = await createTask({
          user_id: userId,
          description: messageText,
          type: "followup",
          assigned_to: person.name,
          status: "pending",
          needs_follow_up: true,
          confirmation_url: null,
          due_at: null,
        });
      } catch (err) {
        return `Could not save the follow-up task. ${err instanceof Error ? err.message : "Please try again."}`;
      }

      // 7. Build and persist confirmation URL
      const confirmationUrl = `${window.location.origin}/confirm?task=${task.id}`;
      try {
        await updateTaskConfirmationUrl(task.id, confirmationUrl);
      } catch {
        // Non-fatal — continue without URL patch; send will still work
      }

      // 8. Create message row (for tracking + Messages screen)
      let messageRecord;
      try {
        messageRecord = await createMessage({
          user_id: userId,
          task_id: task.id,
          recipient: person.name,
          content: messageText,
          confirmation_url: confirmationUrl,
        });
      } catch {
        // Non-fatal — message row is for tracking; proceed to send
      }

      // 9. Send via WhatsApp Cloud API (throws on failure)
      try {
        await sendWhatsAppTask({
          to: person.phone,
          messageText,
          confirmationLink: confirmationUrl,
          messageRecordId: messageRecord?.id ?? null,
          taskId: task.id,
          recipientName: person.name,
        });
      } catch (err) {
        return `Could not send the WhatsApp message to ${person.name}. ${err instanceof Error ? err.message : "Please try again."}`;
      }

      // 10. Record cooldown and return success
      lastSentRef.current.set(cooldownKey, Date.now());
      return `Sent follow-up to ${person.name} about ${topicLabel}.`;
    },
    [],
  );

  // ------------------------------------------------------------------
  // Call management
  // ------------------------------------------------------------------
  const startCall = useCallback(async () => {
    if (!agentId || status !== "idle") return;
    setStatus("connecting");
    setErrorMsg(null);

    try {
      const conv = await Conversation.startSession({
        agentId,
        dynamicVariables: {
          ra7etbal_state: briefStateText,
        },
        clientTools: {
          send_followup: sendFollowup,
        },
        onModeChange: ({ mode: m }) => {
          setMode(m === "speaking" ? "speaking" : "listening");
        },
        onDisconnect: () => {
          conversationRef.current = null;
          setStatus("idle");
          setMode("listening");
        },
        onError: (msg) => {
          conversationRef.current = null;
          setStatus("error");
          setErrorMsg(msg);
          setTimeout(() => {
            setStatus("idle");
            setErrorMsg(null);
          }, 3000);
        },
        onConnect: () => {
          setStatus("connected");
        },
      });
      conversationRef.current = conv;
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Couldn't start call");
      setTimeout(() => {
        setStatus("idle");
        setErrorMsg(null);
      }, 3000);
    }
  }, [agentId, briefStateText, sendFollowup, status]);

  // ------------------------------------------------------------------
  // Session teardown — single shared function used by all exit paths
  // ------------------------------------------------------------------
  const stopSession = useCallback(() => {
    if (conversationRef.current) {
      conversationRef.current.endSession();
      conversationRef.current = null;
    }
    setStatus("idle");
    setMode("listening");
  }, []);

  const endCall = stopSession;

  // ------------------------------------------------------------------
  // Lifecycle cleanup — unmount, visibility, pagehide, beforeunload
  // ------------------------------------------------------------------
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        stopSession();
      }
    }

    function handlePageHide() {
      stopSession();
    }

    function handleBeforeUnload() {
      stopSession();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      // Component unmount (navigation away, sign-out, PWA removal)
      stopSession();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [stopSession]);

  if (!agentId) return null;

  return (
    <div
      className="fixed z-40"
      style={{
        bottom: "calc(env(safe-area-inset-bottom) + 148px)",
        right: "20px",
      }}
    >
      {status === "idle" && (
        <button
          type="button"
          onClick={startCall}
          aria-label="Talk to Ra7etBal"
          className="flex items-center gap-2 rounded-full border border-charcoal/20 bg-warm-white px-4 py-2.5 shadow-[0_6px_20px_-4px_rgba(20,20,20,0.30)] transition hover:bg-white hover:shadow-[0_8px_24px_-4px_rgba(20,20,20,0.36)] active:scale-95"
        >
          <MicIcon className="h-4 w-4 text-charcoal" />
          <span className="text-[13px] font-semibold text-charcoal">
            Talk to Ra7etBal
          </span>
        </button>
      )}

      {status === "connecting" && (
        <div className="flex items-center gap-2 rounded-full border border-charcoal/15 bg-warm-white px-4 py-2.5 shadow-[0_4px_16px_-4px_rgba(20,20,20,0.22)]">
          <PulsingDot color="bg-sage" />
          <span className="text-[13px] font-medium text-text">
            Connecting…
          </span>
        </div>
      )}

      {status === "connected" && (
        <button
          type="button"
          onClick={endCall}
          aria-label="End call"
          className="flex items-center gap-2.5 rounded-full border border-charcoal/20 bg-warm-white px-4 py-2.5 shadow-[0_4px_16px_-4px_rgba(20,20,20,0.28)] transition hover:bg-white active:scale-95"
        >
          {mode === "speaking" ? (
            <PulsingDot color="bg-gold" />
          ) : (
            <PulsingDot color="bg-sage" />
          )}
          <span className="text-[13px] font-semibold text-charcoal">
            {mode === "speaking" ? "Speaking…" : "Listening…"}
          </span>
          <span className="ml-0.5 text-[11px] font-bold uppercase tracking-[0.16em] text-text">
            End
          </span>
        </button>
      )}

      {status === "error" && (
        <div className="flex items-center gap-2 rounded-full border border-danger/20 bg-warm-white/95 px-4 py-2.5 shadow-sm backdrop-blur-sm">
          <span className="h-2 w-2 rounded-full bg-danger" />
          <span className="max-w-[160px] truncate text-[12px] text-danger">
            {errorMsg ?? "Error — tap to retry"}
          </span>
        </div>
      )}
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="9" y1="22" x2="15" y2="22" />
    </svg>
  );
}

function PulsingDot({ color }: { color: string }) {
  return (
    <span
      className="relative flex h-2.5 w-2.5 items-center justify-center"
      aria-hidden
    >
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${color}`}
      />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}
