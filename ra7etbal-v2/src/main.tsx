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

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
