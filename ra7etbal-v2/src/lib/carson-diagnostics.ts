/**
 * Carson disconnect diagnostics buffer (DEV/TROUBLESHOOTING ONLY).
 *
 * A tiny in-memory ring buffer, mirrored to localStorage so events survive a
 * client navigation or a mobile PWA reload between the session dropping (on
 * Home) and opening the hidden /debug/carson view.
 *
 * Paired with the console diagnostics added in commit 729ad00. This module adds
 * NO behavior — it only records events already being logged.
 *
 * EASY REMOVAL: delete this file, src/routes/CarsonDebug.tsx, the
 * <CarsonDebugOverlay/> mount in App.tsx, and the recordCarsonDiagnostic() calls
 * in ElevenLabsAgentWidget.tsx.
 */

export interface CarsonDiagnosticEvent {
  kind:
    | "carson-disconnect"
    | "carson-teardown"
    | "carson-error"
    | "carson-unhandled-tool"
    | "carson-latency"
    | "carson-plan"
    | "carson-plan-audit"
    | "carson-direct-tool"
    | "carson-audio-warmup";
  at: string;
  data: unknown;
}

const STORAGE_KEY = "carson:diagnostics";
const MAX_EVENTS = 50;

let buffer: CarsonDiagnosticEvent[] = load();

function load(): CarsonDiagnosticEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
  } catch {
    // Ignore quota / private-mode / SSR failures — in-memory buffer still works.
  }
}

/** Record one diagnostic event. Newest is kept at the end. */
export function recordCarsonDiagnostic(
  kind: CarsonDiagnosticEvent["kind"],
  data: unknown,
): void {
  buffer.push({ kind, at: new Date().toISOString(), data });
  if (buffer.length > MAX_EVENTS) buffer = buffer.slice(-MAX_EVENTS);
  persist();
}

/** Returns the recorded events, newest first. */
export function getCarsonDiagnostics(): CarsonDiagnosticEvent[] {
  return [...buffer].reverse();
}

/** Clears the buffer (both in-memory and persisted). */
export function clearCarsonDiagnostics(): void {
  buffer = [];
  persist();
}
