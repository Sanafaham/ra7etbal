import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  createSessionBinding,
  verifySessionBinding,
  diagnoseSessionBinding,
  providerSecret,
  equalSecret,
  getBearer,
  extractVoiceBindingToken,
  looksLikeVoiceBoundaryRequest,
  extractLatestUserMessage,
  streamOwnerResultAsChatCompletion,
} from "./_carson-second-brain-voice-boundary.js";

const TEST_SESSION_SECRET = "session-signing-secret-for-tests-32b!!";
const TEST_PROVIDER_SECRET = "provider-secret-for-tests-only-32bytes!!";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function configure() {
  process.env.CARSON_SECOND_BRAIN_SESSION_SECRET = TEST_SESSION_SECRET;
  process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET = TEST_PROVIDER_SECRET;
}

describe("session binding — embeds the owner's own JWT, not just an account id", () => {
  it("issues a signed binding carrying the caller-supplied jwt snapshot", () => {
    configure();
    const { token, payload } = createSessionBinding({ accountId: "owner-1", jwt: "real-jwt-value" });
    expect(payload.sub).toBe("owner-1");
    expect(payload.jwt).toBe("real-jwt-value");
    const verified = verifySessionBinding(token);
    expect(verified?.sub).toBe("owner-1");
    expect(verified?.jwt).toBe("real-jwt-value");
  });

  it("rejects a binding with no embedded jwt (malformed/tampered)", () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "real-jwt" });
    const [encodedPayload] = token.split(".");
    const badPayload = Buffer.from(
      JSON.stringify({ v: 1, sub: "owner-1", sid: "x", iat: 1, exp: 601 }),
    ).toString("base64url");
    // Re-signing with the real secret to isolate: this tests the payload
    // shape check, not signature tampering.
    const sig = createHmac("sha256", TEST_SESSION_SECRET).update(badPayload).digest("base64url");
    expect(verifySessionBinding(`${badPayload}.${sig}`, { now: 1000 })).toBeNull();
    expect(encodedPayload).toBeTruthy(); // sanity: real token did have a payload segment
  });

  it("rejects an expired binding", () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j", now: 0 });
    expect(verifySessionBinding(token, { now: 20 * 60 * 1000 })).toBeNull();
  });

  it("rejects a tampered signature", () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
    const [payload] = token.split(".");
    expect(verifySessionBinding(`${payload}.garbage-signature-of-wrong-length`)).toBeNull();
  });

  it("fails closed (returns null, never throws) when signing secret is unconfigured", () => {
    delete process.env.CARSON_SECOND_BRAIN_SESSION_SECRET;
    expect(() => verifySessionBinding("anything.anything")).not.toThrow();
    expect(verifySessionBinding("anything.anything")).toBeNull();
  });
});

describe("provider secret", () => {
  it("throws when unconfigured — callers must treat this as fail-closed (503), never silently pass", () => {
    delete process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET;
    expect(() => providerSecret()).toThrow();
  });

  it("equalSecret is timing-safe-shaped: correct match true, wrong/short/long false", () => {
    configure();
    const expected = providerSecret();
    expect(equalSecret(expected, expected)).toBe(true);
    expect(equalSecret("wrong", expected)).toBe(false);
    expect(equalSecret("", expected)).toBe(false);
  });

  it("getBearer extracts only a well-formed Bearer header", () => {
    expect(getBearer({ headers: { authorization: "Bearer abc" } })).toBe("abc");
    expect(getBearer({ headers: {} })).toBe("");
    expect(getBearer({ headers: { authorization: "Basic abc" } })).toBe("");
  });

  it("getBearer trims incidental leading/trailing whitespace so a stray paste artifact never causes a false rejection", () => {
    expect(getBearer({ headers: { authorization: "Bearer abc\n" } })).toBe("abc");
    expect(getBearer({ headers: { authorization: "Bearer abc " } })).toBe("abc");
    expect(getBearer({ headers: { authorization: "Bearer  abc\r\n" } })).toBe("abc");
  });

  it("a provider secret with an incidental trailing newline in the dashboard still authenticates correctly", () => {
    const expected = "provider-secret-for-tests-only-32bytes!!";
    // Simulates a dashboard secret field that stored the pasted value with a
    // trailing newline the person pasting never saw.
    const supplied = getBearer({ headers: { authorization: `Bearer ${expected}\n` } });
    expect(equalSecret(supplied, expected)).toBe(true);
  });
});

describe("extractVoiceBindingToken — deterministic transport precedence", () => {
  it("reads the X-Carson-Second-Brain-Binding header when present", () => {
    const req = { headers: { "x-carson-second-brain-binding": "header-token" }, body: {} };
    expect(extractVoiceBindingToken(req)).toBe("header-token");
  });

  it("falls back to elevenlabs_extra_body when no header is present", () => {
    const req = { headers: {}, body: { elevenlabs_extra_body: { carson_second_brain_binding: "legacy-token" } } };
    expect(extractVoiceBindingToken(req)).toBe("legacy-token");
  });

  it("prefers the header over the body field when both are present", () => {
    const req = {
      headers: { "x-carson-second-brain-binding": "header-token" },
      body: { elevenlabs_extra_body: { carson_second_brain_binding: "legacy-token" } },
    };
    expect(extractVoiceBindingToken(req)).toBe("header-token");
  });

  it("returns undefined (fail closed) when neither transport supplies a value", () => {
    expect(extractVoiceBindingToken({ headers: {}, body: {} })).toBeUndefined();
  });

  it("never reads from a query string", () => {
    const req = { headers: {}, body: {}, query: { carson_second_brain_binding: "query-token" } };
    expect(extractVoiceBindingToken(req)).toBeUndefined();
  });
});

describe("looksLikeVoiceBoundaryRequest — distinguishes ElevenLabs' shape from the typed browser shape", () => {
  it("true for an OpenAI-style messages array with no typed transcript field", () => {
    expect(looksLikeVoiceBoundaryRequest({ body: { messages: [{ role: "user", content: "hi" }] } })).toBe(true);
  });

  it("false for the existing typed-browser request shape", () => {
    expect(looksLikeVoiceBoundaryRequest({ body: { transcript: "hi", turnId: "t1" } })).toBe(false);
  });

  it("false when messages is absent or not an array", () => {
    expect(looksLikeVoiceBoundaryRequest({ body: {} })).toBe(false);
    expect(looksLikeVoiceBoundaryRequest({ body: { messages: "not-an-array" } })).toBe(false);
  });
});

describe("extractLatestUserMessage", () => {
  it("returns the most recent user-role message text", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "What needs my attention?" },
    ];
    expect(extractLatestUserMessage(messages)).toBe("What needs my attention?");
  });

  it("joins array-shaped text-part content", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] }];
    expect(extractLatestUserMessage(messages)).toBe("part one part two");
  });

  it("returns empty string when there is no user message", () => {
    expect(extractLatestUserMessage([{ role: "assistant", content: "hi" }])).toBe("");
    expect(extractLatestUserMessage(undefined)).toBe("");
  });
});

describe("streamOwnerResultAsChatCompletion — relays the exact grounded text, never a second generation", () => {
  function mockRes() {
    const chunks = [];
    return {
      chunks,
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      write(chunk) {
        chunks.push(chunk);
      },
      end: vi.fn(),
    };
  }

  it("streams the ownerResult text as one assistant turn with exactly one [DONE]", () => {
    const res = mockRes();
    streamOwnerResultAsChatCompletion(res, { completionId: "c1", text: "Nothing needs your attention right now." });
    const full = res.chunks.join("");
    expect(full).toContain("Nothing needs your attention right now.");
    expect((full.match(/data: \[DONE\]/g) || []).length).toBe(1);
    expect((full.match(/"finish_reason":"stop"/g) || []).length).toBe(1);
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("sets SSE headers", () => {
    const res = mockRes();
    streamOwnerResultAsChatCompletion(res, { completionId: "c1", text: "x" });
    expect(res.headers["Content-Type"]).toContain("text/event-stream");
  });
});

describe("diagnoseSessionBinding — safe, secret-free 401 diagnostics", () => {
  it("reports absent when no token is supplied", () => {
    expect(diagnoseSessionBinding(undefined)).toEqual({
      binding_present: false,
      binding_parse_ok: false,
      binding_signature_ok: false,
      binding_expired: false,
      owner_jwt_present: false,
    });
  });

  it("reports present-but-unparseable for a malformed token", () => {
    const result = diagnoseSessionBinding("not-a-real-token");
    expect(result.binding_present).toBe(true);
    expect(result.binding_parse_ok).toBe(false);
  });

  it("reports parse-ok but signature-mismatch for a token signed with a different secret", () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "owner-jwt" }, "a-completely-different-secret-32b!!");
    const result = diagnoseSessionBinding(token, { secret: TEST_SESSION_SECRET });
    expect(result.binding_present).toBe(true);
    expect(result.binding_parse_ok).toBe(true);
    expect(result.binding_signature_ok).toBe(false);
  });

  it("reports a valid, unexpired binding as fully ok with owner_jwt_present true", () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "owner-jwt" }, TEST_SESSION_SECRET);
    const result = diagnoseSessionBinding(token, { secret: TEST_SESSION_SECRET });
    expect(result).toEqual({
      binding_present: true,
      binding_parse_ok: true,
      binding_signature_ok: true,
      binding_expired: false,
      owner_jwt_present: true,
    });
  });

  it("reports an expired binding as such even though its signature is valid", () => {
    configure();
    const { token } = createSessionBinding(
      { accountId: "owner-1", jwt: "owner-jwt", now: Date.now() - 20 * 60 * 1000 },
      TEST_SESSION_SECRET,
    );
    const result = diagnoseSessionBinding(token, { secret: TEST_SESSION_SECRET });
    expect(result.binding_signature_ok).toBe(true);
    expect(result.binding_expired).toBe(true);
  });

  it("never includes the token, the JWT, or either secret in its output", () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "super-secret-owner-jwt" }, TEST_SESSION_SECRET);
    const result = diagnoseSessionBinding(token, { secret: TEST_SESSION_SECRET });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("super-secret-owner-jwt");
    expect(serialized).not.toContain(TEST_SESSION_SECRET);
  });
});
