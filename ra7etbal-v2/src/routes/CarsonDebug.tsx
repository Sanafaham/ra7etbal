/**
 * Hidden Carson diagnostics view (DEV/TROUBLESHOOTING ONLY).
 *
 * Not linked anywhere in the UI. Only renders when the URL is /debug/carson
 * (any deeper path also matches) OR carries ?carsonDebug=1. Returns null for
 * every normal user/route, so it never appears in normal navigation or Settings.
 *
 * Shows the latest [carson-disconnect] / [carson-teardown] / [carson-error] /
 * [carson-unhandled-tool] events captured by carson-diagnostics.ts.
 *
 * EASY REMOVAL: delete this file, remove the <CarsonDebugOverlay/> mount and its
 * import in App.tsx, and delete src/lib/carson-diagnostics.ts plus the
 * recordCarsonDiagnostic() calls in ElevenLabsAgentWidget.tsx.
 */
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  clearCarsonDiagnostics,
  getCarsonDiagnostics,
  type CarsonDiagnosticEvent,
} from "../lib/carson-diagnostics";

const KIND_COLORS: Record<CarsonDiagnosticEvent["kind"], string> = {
  "carson-disconnect": "#b45309",
  "carson-teardown": "#0369a1",
  "carson-error": "#b91c1c",
  "carson-unhandled-tool": "#7c3aed",
};

export default function CarsonDebugOverlay() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const visible =
    location.pathname.startsWith("/debug/carson") ||
    params.get("carsonDebug") === "1";

  const [events, setEvents] = useState<CarsonDiagnosticEvent[]>([]);

  useEffect(() => {
    if (visible) setEvents(getCarsonDiagnostics());
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#0c0a09",
        color: "#e7e5e4",
        font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
        overflowY: "auto",
        padding: "16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <strong style={{ fontSize: 15 }}>Carson Diagnostics</strong>
        <span style={{ color: "#a8a29e" }}>({events.length})</span>
        <button
          onClick={() => setEvents(getCarsonDiagnostics())}
          style={btnStyle}
        >
          Refresh
        </button>
        <button
          onClick={() => {
            clearCarsonDiagnostics();
            setEvents([]);
          }}
          style={btnStyle}
        >
          Clear
        </button>
        <a href="/" style={{ ...btnStyle, textDecoration: "none" }}>
          Close
        </a>
      </div>

      {events.length === 0 ? (
        <p style={{ color: "#a8a29e" }}>
          No diagnostic events recorded yet. Start a Carson session, reproduce a
          disconnect, then reopen this page.
        </p>
      ) : (
        events.map((ev, i) => (
          <div
            key={i}
            style={{
              borderLeft: `3px solid ${KIND_COLORS[ev.kind] ?? "#57534e"}`,
              padding: "8px 10px",
              marginBottom: 8,
              background: "#1c1917",
              borderRadius: 4,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ color: KIND_COLORS[ev.kind] ?? "#e7e5e4", fontWeight: 600 }}>
                {ev.kind}
              </span>
              <span style={{ color: "#a8a29e" }}>{ev.at}</span>
            </div>
            <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {safeStringify(ev.data)}
            </pre>
          </div>
        ))
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#292524",
  color: "#e7e5e4",
  border: "1px solid #44403c",
  borderRadius: 4,
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
