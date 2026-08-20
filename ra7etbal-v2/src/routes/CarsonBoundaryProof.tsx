import { Conversation, type Conversation as ElevenLabsConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";

type ProofScenario = "fixed" | "delayed" | "retry_once";
type TranscriptLine = { role: "user" | "agent"; message: string };

const agentId = import.meta.env.VITE_CARSON_STAGE2A_AGENT_ID;

/**
 * Fixed opening line for the isolated proof. The cloned agent's first message is
 * "{{opening_line}}", so ElevenLabs requires this dynamic variable at session
 * start. It is a constant literal — this proof never computes a Carson brief.
 */
export const STAGE2A_OPENING_LINE = "Boundary proof session.";

export function isCarsonBoundaryProofPath(pathname: string) {
  return pathname === "/non-production/carson-boundary-proof";
}

export default function CarsonBoundaryProof() {
  const { status } = useAuth();
  const conversationRef = useRef<ElevenLabsConversation | null>(null);
  const [connection, setConnection] = useState("disconnected");
  const [scenario, setScenario] = useState<ProofScenario>("fixed");
  const [conversationId, setConversationId] = useState("");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState("");

  useEffect(() => () => { void conversationRef.current?.endSession(); }, []);

  async function start() {
    setError("");
    setTranscript([]);
    if (!agentId) return setError("The non-production Stage 2A agent is not configured for this preview.");
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) return setError("Please sign in before starting the boundary proof.");
    setConnection("connecting");
    try {
      const bindingResponse = await fetch("/api/carson-custom-llm-stage2a", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action: "issue_session_binding", scenario }),
      });
      if (!bindingResponse.ok) throw new Error("Could not create the short-lived account binding.");
      const binding = await bindingResponse.json();
      const conversation = await Conversation.startSession({
        agentId,
        // The non-production agent is cloned from Carson, whose first message is
        // just "{{opening_line}}". ElevenLabs refuses the session (close 1008,
        // agent_configuration_error) unless that variable is supplied. This proof
        // deliberately sends a fixed literal — no brief, no Carson reasoning.
        dynamicVariables: { opening_line: STAGE2A_OPENING_LINE },
        customLlmExtraBody: { carson_stage2a_binding: binding.binding },
        connectionDelay: { default: 0, android: 3_000, ios: 500 },
        onConnect: ({ conversationId: id }) => { setConversationId(id); setConnection("connected"); },
        onDisconnect: () => { setConnection("disconnected"); conversationRef.current = null; },
        onError: (message) => setError(message),
        onMessage: ({ role, message }) => setTranscript((current) => [...current, { role, message }]),
      });
      conversationRef.current = conversation;
    } catch (caught) {
      setConnection("disconnected");
      setError(caught instanceof Error ? caught.message : "The proof session could not start.");
    }
  }

  async function end() {
    await conversationRef.current?.endSession();
    conversationRef.current = null;
    setConnection("disconnected");
  }

  if (status === "loading") return <main className="mx-auto max-w-xl p-8">Checking account…</main>;
  if (status !== "signed_in") return <main className="mx-auto max-w-xl p-8">Sign in to Ra7etBal first, then reopen this non-production proof route.</main>;

  return (
    <main className="mx-auto min-h-screen max-w-xl px-6 py-10 text-ink">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/50">Non-production · Stage 2A</p>
      <h1 className="mt-3 text-3xl font-semibold">Carson voice boundary proof</h1>
      <p className="mt-3 text-sm leading-6 text-ink/65">This isolated agent has no tools and always returns the server-owned sentence “Boundary proof successful.”</p>

      <label className="mt-8 block text-sm font-medium" htmlFor="proof-scenario">Proof scenario</label>
      <select id="proof-scenario" value={scenario} onChange={(event) => setScenario(event.target.value as ProofScenario)} disabled={connection !== "disconnected"} className="mt-2 w-full rounded-xl border border-ink/15 bg-white px-4 py-3">
        <option value="fixed">Exact response</option>
        <option value="delayed">Interruption (3-second delay)</option>
        <option value="retry_once">Provider retry (first request fails)</option>
      </select>

      <div className="mt-5 flex gap-3">
        <button type="button" onClick={() => void start()} disabled={connection !== "disconnected"} className="rounded-xl bg-ink px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">Start proof</button>
        <button type="button" onClick={() => void end()} disabled={connection === "disconnected"} className="rounded-xl border border-ink/20 px-5 py-3 text-sm font-semibold disabled:opacity-40">End</button>
      </div>

      <dl className="mt-7 grid gap-2 rounded-2xl bg-white/70 p-5 text-sm">
        <div><dt className="inline font-medium">Status: </dt><dd className="inline">{connection}</dd></div>
        <div><dt className="inline font-medium">Conversation: </dt><dd className="inline break-all">{conversationId || "not started"}</dd></div>
      </dl>
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-800">{error}</p>}
      <section aria-label="Proof transcript" className="mt-6 space-y-3">
        {transcript.map((line, index) => <p key={`${line.role}-${index}`} data-role={line.role} className="rounded-xl border border-ink/10 bg-white p-4 text-sm"><strong>{line.role === "user" ? "Owner" : "Agent"}:</strong> {line.message}</p>)}
      </section>
    </main>
  );
}
