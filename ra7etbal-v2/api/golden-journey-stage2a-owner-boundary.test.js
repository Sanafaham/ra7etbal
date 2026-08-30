/**
 * Golden Journey — Corrected Path C Stage 2A owner-authenticated Custom LLM boundary.
 *
 * Proves the whole owner journey in one test, end to end, against the real
 * handler:
 *
 *   signed-in owner
 *     -> server authenticates the owner JWT (Supabase)
 *     -> server issues a short-lived, account-bound session binding
 *     -> binding travels to ElevenLabs and returns in elevenlabs_extra_body
 *     -> provider authentication passes
 *     -> server validates the owner binding
 *     -> canonical SSE is returned
 *     -> exactly "Boundary proof successful."
 *
 * WHAT THIS DOES NOT PROVE — recorded honestly, because the 2026-08-20
 * investigation turned on exactly this gap. Only ElevenLabs' own
 * infrastructure can prove that it actually dispatches an outbound request
 * to the configured Custom LLM URL. For a long period it attempted
 * generation and aborted before any HTTP request left its infrastructure,
 * and no offline test could have detected that. The live acceptance
 * evidence is conversation conv_7501m0gsp7v2e6mam5kbyrsrr405
 * (2026-08-20T23:56:51Z): real proof page, real voice, real signed-in
 * owner, four owner turns, three responses exactly
 * "Boundary proof successful." and a fourth carrying the same canonical
 * sentence with a trailing ellipsis. Re-run that human acceptance only
 * when the ElevenLabs agent or the proof page changes — never per CI run,
 * which would spend credits for no added protection.
 *
 * This test uses no live ElevenLabs conversation, no credits, no real
 * owner credentials, no network, and performs no production read or write.
 * The Supabase owner-authentication boundary is injected, matching the
 * handler's own `authenticate` seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStage2aHandler, STAGE2A_RESPONSE, verifySessionBinding } from "./carson-custom-llm-stage2a.js";

const PROVIDER_SECRET = "journey-provider-secret-at-least-32-bytes";
const SESSION_SECRET = "journey-session-secret-at-least-32-bytes";
const OWNER_ACCOUNT_ID = "3f7a1c02-owner-account-uuid";
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function configure() {
  process.env.CARSON_STAGE2A_PROVIDER_SECRET = PROVIDER_SECRET;
  process.env.CARSON_STAGE2A_SESSION_SECRET = SESSION_SECRET;
}

function res() {
  return {
    statusCode: 200,
    payload: null,
    chunks: [],
    headers: {},
    writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    write(value) { this.chunks.push(value); },
    end() { this.writableEnded = true; },
    on: vi.fn(),
  };
}

/** Stage 1 of the journey: the proof page asks the server for a binding. */
async function issueBindingAsOwner({ authenticate }) {
  const handler = createStage2aHandler({ authenticate });
  const out = res();
  await handler(
    { method: "POST", headers: { authorization: "Bearer owner-supabase-jwt" }, body: { action: "issue_session_binding", scenario: "fixed" }, on: vi.fn() },
    out,
  );
  return out;
}

/** Stage 2 of the journey: ElevenLabs calls the Custom LLM with that binding. */
async function elevenLabsTurn(binding, { authorization = `Bearer ${PROVIDER_SECRET}` } = {}) {
  vi.useFakeTimers();
  const out = res();
  await createStage2aHandler()(
    {
      method: "POST",
      headers: { authorization },
      body: {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "assistant", content: "Boundary proof session." },
          { role: "user", content: "Hi Carson" },
        ],
        model: "carson-stage2a-fixed",
        stream: true,
        elevenlabs_extra_body: { carson_stage2a_binding: binding },
      },
      on: vi.fn(),
    },
    out,
  );
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  return out;
}

function spokenContent(out) {
  return out.chunks
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l.slice(6) !== "[DONE]")
    .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "")
    .join("");
}

describe("Golden Journey — Stage 2A owner-authenticated Custom LLM boundary", () => {
  it("completes the full owner journey and returns exactly the canonical server-owned sentence", async () => {
    configure();
    const authenticate = vi.fn().mockResolvedValue(OWNER_ACCOUNT_ID);

    // 1. Owner is authenticated and a binding is issued, bound to that owner.
    const issued = await issueBindingAsOwner({ authenticate });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(issued.statusCode).toBe(200);
    const binding = issued.payload.binding;
    expect(typeof binding).toBe("string");

    // 2. The binding is genuinely account-bound and short-lived.
    const decoded = verifySessionBinding(binding, { secret: SESSION_SECRET });
    expect(decoded).toMatchObject({ sub: OWNER_ACCOUNT_ID, scenario: "fixed" });
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
    expect(issued.payload.sessionId).toBe(decoded.sid);

    // 3. ElevenLabs presents provider credentials plus that owner binding.
    const turn = await elevenLabsTurn(binding);

    // 4. Canonical SSE, server-owned content, correct termination.
    expect(turn.statusCode).toBe(200);
    expect(String(turn.headers["content-type"])).toContain("text/event-stream");
    expect(spokenContent(turn)).toBe("Boundary proof successful.");
    expect(spokenContent(turn)).toBe(STAGE2A_RESPONSE);
    expect(turn.chunks.join("").trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(turn.writableEnded).toBe(true);

    // 5. No tool call, no second model, no execution surface.
    expect(turn.chunks.join("")).not.toContain("tool_calls");
  });

  it("refuses to issue a binding when the owner is not authenticated", async () => {
    configure();
    const authenticate = vi.fn().mockResolvedValue(null);
    const issued = await issueBindingAsOwner({ authenticate });
    expect(issued.statusCode).toBe(401);
    expect(issued.payload).toEqual({ error: "Unauthorized" });
    expect(issued.payload.binding).toBeUndefined();
  });

  it("binds the session to the authenticated owner, so a different owner gets a different binding subject", async () => {
    configure();
    const first = await issueBindingAsOwner({ authenticate: vi.fn().mockResolvedValue("owner-a") });
    const second = await issueBindingAsOwner({ authenticate: vi.fn().mockResolvedValue("owner-b") });
    expect(verifySessionBinding(first.payload.binding, { secret: SESSION_SECRET }).sub).toBe("owner-a");
    expect(verifySessionBinding(second.payload.binding, { secret: SESSION_SECRET }).sub).toBe("owner-b");
    expect(first.payload.binding).not.toBe(second.payload.binding);
  });

  it("does not reach the canonical response when provider authentication fails, even with a valid owner binding", async () => {
    configure();
    const issued = await issueBindingAsOwner({ authenticate: vi.fn().mockResolvedValue(OWNER_ACCOUNT_ID) });
    const turn = await elevenLabsTurn(issued.payload.binding, { authorization: "Bearer not-the-provider-secret" });
    expect(turn.statusCode).toBe(401);
    expect(turn.chunks).toEqual([]);
  });

  it("does not reach the canonical response when the owner binding is absent, even with valid provider authentication", async () => {
    configure();
    const turn = await elevenLabsTurn(undefined);
    expect(turn.statusCode).toBe(401);
    expect(turn.payload).toEqual({ error: "Invalid or expired session binding" });
    expect(turn.chunks).toEqual([]);
  });
});
