import { createElement, useEffect } from "react";

const WIDGET_SCRIPT_ID = "elevenlabs-convai-widget";
const WIDGET_SCRIPT_SRC = "https://unpkg.com/@elevenlabs/convai-widget-embed";

export default function ElevenLabsAgentWidget({
  briefStateText,
}: {
  briefStateText: string;
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
    <div
      className="fixed z-40"
      style={{
        bottom: "calc(env(safe-area-inset-bottom) + 112px)",
        right: "16px",
      }}
    >
      {createElement("elevenlabs-convai", {
        "agent-id": agentId,
        variant: "compact",
        "action-text": "Talk to Ra7etBal",
        "start-call-text": "Talk to Ra7etBal",
        "dynamic-variables": JSON.stringify({
          ra7etbal_state: briefStateText,
        }),
      })}
    </div>
  );
}
