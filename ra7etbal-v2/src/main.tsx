import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/globals.css";
// Side-effect import: installs the Supabase auth listener BEFORE React mounts.
// Order matters — do not move below `createRoot`.
import "./lib/session";
// Cross-store coupling (clears caches on sign-out etc). Must run after the
// session listener exists but before React mounts.
import "./stores/sync";
import { supabaseConfigError } from "./lib/supabase";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

if (supabaseConfigError) {
  // A deployment (e.g. an isolated preview/proof project) missing required
  // frontend env vars must never render a blank white page — show exactly
  // what's misconfigured instead of leaving the visitor with nothing.
  rootEl.replaceChildren(renderStartupDiagnostic(supabaseConfigError));
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

function renderStartupDiagnostic(message: string): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText =
    "font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e7e5e4; " +
    "background: #0c0a09; padding: 24px; max-width: 640px; margin: 40px auto; border-radius: 8px;";
  const title = document.createElement("strong");
  title.textContent = "Ra7etBal failed to start.";
  title.style.cssText = "display:block; font-size: 16px; margin-bottom: 12px; color: #fca5a5;";
  const detail = document.createElement("pre");
  detail.textContent = message;
  detail.style.cssText = "white-space: pre-wrap; word-break: break-word; margin: 0;";
  container.append(title, detail);
  return container;
}
