import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "SettingsModal.tsx"), "utf-8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/**
 * Google Calendar Connect — authenticated OAuth initiation (Carson
 * Engineering Hardening Project, Remediation 3). Source-text assertions,
 * matching this file's existing testing convention (no
 * @testing-library/react dependency in this project).
 *
 * Server-side behavior (identity binding, state generation/validation) is
 * covered by api/google-calendar.oauth-state.test.js. These tests only
 * prove the client no longer sends a raw, unauthenticated userId and
 * instead completes an authenticated pre-flight step before navigating.
 */
describe("SettingsModal — Google Calendar authenticated connect flow", () => {
  const handleConnectBlock = () =>
    blockBetween("async function handleConnect() {", "const isRevoked = revoked");

  it("no longer sends a raw, unauthenticated userId query param to /api/google-calendar", () => {
    expect(SOURCE).not.toContain("/api/google-calendar?userId=");
  });

  it("calls the authenticated init route with the current session's JWT as a Bearer header", () => {
    const block = handleConnectBlock();
    expect(block).toContain("supabase.auth.getSession()");
    expect(block).toContain('fetch("/api/google-calendar?action=init"');
    expect(block).toContain("Authorization: `Bearer ${jwt}`");
  });

  it("navigates only to the server-issued redirectUrl, never a client-constructed URL", () => {
    const block = handleConnectBlock();
    const jwtCheckIndex = block.indexOf("if (!jwt)");
    const navigateIndex = block.indexOf("window.location.href = body.redirectUrl;");
    expect(jwtCheckIndex).toBeGreaterThan(-1);
    expect(navigateIndex).toBeGreaterThan(jwtCheckIndex);
  });

  it("does not navigate when there is no session or the init call fails", () => {
    const block = handleConnectBlock();
    const noJwtBlock = block.slice(block.indexOf("if (!jwt)"), block.indexOf("try {"));
    expect(noJwtBlock).not.toContain("window.location.href");
    expect(noJwtBlock).toContain("setConnectError(true)");

    const failureBlock = block.slice(
      block.indexOf("if (!res.ok || !body?.redirectUrl)"),
      block.indexOf("onReconnected?.();"),
    );
    expect(failureBlock).not.toContain("window.location.href");
    expect(failureBlock).toContain("setConnectError(true)");
    expect(failureBlock).toContain("return;");
  });

  it("surfaces a retry-able error state without leaking any technical detail", () => {
    expect(SOURCE).toContain('"Something went wrong — tap to retry"');
  });
});
