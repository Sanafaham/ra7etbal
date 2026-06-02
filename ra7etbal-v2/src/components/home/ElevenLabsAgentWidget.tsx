import { createElement, useEffect } from "react";

const WIDGET_SCRIPT_ID = "elevenlabs-convai-widget";
const WIDGET_SCRIPT_SRC = "https://unpkg.com/@elevenlabs/convai-widget-embed";

export interface ElevenLabsBriefSnapshot {
  summary: string;
  needs_attention_count: number;
  waiting_on_others_count: number;
  later_count: number;
  needs_attention_items: string[];
  waiting_items: string[];
  later_items: string[];
}

export default function ElevenLabsAgentWidget({
  briefSnapshot,
}: {
  briefSnapshot: ElevenLabsBriefSnapshot;
}) {
  const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID?.trim();

  useEffect(() => {
    if (!agentId || typeof document === "undefined") return;
    if (document.getElementById(WIDGET_SCRIPT_ID)) return;

    const script = document.createElement("script");
    script.id = WIDGET_SCRIPT_ID;
    script.src = WIDGET_SCRIPT_SRC;
    script.async = true;
    script.type = "text/javascript";
    document.body.appendChild(script);
  }, [agentId]);

  if (!agentId) return null;

  return (
    <div className="mt-3 flex justify-center">
      {createElement("elevenlabs-convai", {
        "agent-id": agentId,
        "action-text": "Talk to Ra7etBal",
        "start-call-text": "Talk to Ra7etBal",
        "dynamic-variables": JSON.stringify({
          ra7etbal_state: briefSnapshot,
        }),
      })}
    </div>
  );
}
