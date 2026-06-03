import { Conversation } from "@elevenlabs/react";
import { useCallback, useRef, useState } from "react";

type CallStatus = "idle" | "connecting" | "connected" | "error";
type AgentMode = "listening" | "speaking";

export default function ElevenLabsAgentWidget({
  briefStateText,
}: {
  briefStateText: string;
}) {
  const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID?.trim();

  const [status, setStatus] = useState<CallStatus>("idle");
  const [mode, setMode] = useState<AgentMode>("listening");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const conversationRef = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null);

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
  }, [agentId, briefStateText, status]);

  const endCall = useCallback(() => {
    conversationRef.current?.endSession();
    conversationRef.current = null;
    setStatus("idle");
    setMode("listening");
  }, []);

  if (!agentId) return null;

  return (
    <div
      className="fixed z-40"
      style={{
        bottom: "calc(env(safe-area-inset-bottom) + 112px)",
        right: "16px",
      }}
    >
      {status === "idle" && (
        <button
          type="button"
          onClick={startCall}
          aria-label="Talk to Ra7etBal"
          className="flex items-center gap-2 rounded-full border border-sage/30 bg-warm-white/95 px-4 py-2.5 shadow-[0_8px_24px_-8px_rgba(20,20,20,0.22)] backdrop-blur-sm transition hover:bg-white hover:shadow-[0_10px_28px_-8px_rgba(20,20,20,0.28)] active:scale-95"
        >
          <MicIcon className="h-4 w-4 text-sage" />
          <span className="text-[13px] font-semibold tracking-wide text-text">
            Voice
          </span>
        </button>
      )}

      {status === "connecting" && (
        <div className="flex items-center gap-2 rounded-full border border-sage/20 bg-warm-white/95 px-4 py-2.5 shadow-[0_8px_24px_-8px_rgba(20,20,20,0.18)] backdrop-blur-sm">
          <PulsingDot color="bg-sage" />
          <span className="text-[13px] font-medium text-text-soft">
            Connecting…
          </span>
        </div>
      )}

      {status === "connected" && (
        <button
          type="button"
          onClick={endCall}
          aria-label="End call"
          className="flex items-center gap-2.5 rounded-full border border-sage/25 bg-warm-white/97 px-4 py-2.5 shadow-[0_8px_28px_-8px_rgba(20,20,20,0.22)] backdrop-blur-sm transition hover:bg-white active:scale-95"
        >
          {mode === "speaking" ? (
            <PulsingDot color="bg-gold" />
          ) : (
            <PulsingDot color="bg-sage" />
          )}
          <span className="text-[13px] font-medium text-text">
            {mode === "speaking" ? "Speaking…" : "Listening…"}
          </span>
          <span className="ml-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
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
    <span className="relative flex h-2.5 w-2.5 items-center justify-center" aria-hidden>
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${color}`}
      />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}
