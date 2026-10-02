/**
 * Bounded owner-perspective live evidence (owner-authorized, PR #430).
 *
 * EVIDENCE ONLY — no production code. Runs ONLY when
 * OWNER_PERSPECTIVE_LIVE_EVIDENCE=1 (set solely by
 * .github/workflows/owner-perspective-live-evidence.yml); ordinary CI and the
 * full suite skip it and make zero calls.
 *
 * What is real: the production extraction prompt + parser (extractItems,
 * src/lib/ai/extract.ts, model claude-sonnet-4-6) and the single shared
 * owner-perspective boundary (composed voice, the same check save.ts applies).
 * What is replaced: only the transport — the browser /api/anthropic proxy
 * becomes a direct Messages API call with ANTHROPIC_API_KEY.
 *
 * Hard limits: exactly the 12 authorized inputs, one call each, no retry; a
 * 13th provider call, any other network call, any Supabase access or any
 * composer call throws and fails the run. A provider failure consumes its
 * call and is recorded as inconclusive.
 */
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const LIVE = process.env.OWNER_PERSPECTIVE_LIVE_EVIDENCE === "1";
const CALL_CAP = 12;
const MODEL = "claude-sonnet-4-6";

const state = vi.hoisted(() => ({ calls: 0, models: [] as string[], realFetch: null as null | typeof fetch }));

vi.mock("../src/lib/supabase", () => ({
  supabase: new Proxy({}, { get() { throw new Error("SUPABASE ACCESS FORBIDDEN IN EVIDENCE RUN"); } }),
}));
vi.mock("../src/lib/ai/compose-message", () => ({
  composeMergedMessage: () => { throw new Error("COMPOSER FORBIDDEN IN EVIDENCE RUN"); },
}));
vi.mock("../src/lib/anthropic-client", () => ({
  callAnthropicProxy: async (payload: { model: string }) => {
    state.calls += 1;
    if (state.calls > CALL_CAP) throw new Error(`CALL BUDGET EXCEEDED: call ${state.calls} > ${CALL_CAP}`);
    if (payload.model !== MODEL) throw new Error(`UNEXPECTED MODEL ${payload.model}; refusing to substitute`);
    state.models.push(payload.model);
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || !state.realFetch) throw new Error("ANTHROPIC_API_KEY missing or transport not initialised");
    return state.realFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
    });
  },
}));

import { extractItems } from "../src/lib/ai/extract";
import { resolveOwnerPerspective } from "../src/lib/direct-message-owner-normalization";
import type { Person } from "../src/types/person";

const person = (name: string, role: string): Person => ({
  id: `p-${name}`, user_id: "evidence", name, role, phone: null, notes: null, created_at: "2026-01-01T00:00:00Z",
  relationship: null, is_family: role === "family", responsibilities: null, reliability_level: null,
  follow_up_level: null, delegation_guidance: null, should_not_assign: null, escalate_to: null,
  communication_style: null, whatsapp_opted_in: false, whatsapp_consent_at: null, whatsapp_consent_method: null,
}) as Person;
const PEOPLE = [person("Grace", "assistant"), person("Sarah", "friend"), person("Loulya", "family")];
const OWNER = "Sana";

const INPUTS: Array<[string, string]> = [
  ["en", "Tell Sarah I'm running late tonight."],
  ["en", "Tell Loulya I love her."],
  ["en", "Ask Grace to take Loulya to her appointment and call me after."],
  ["en", "Tell Grace Ali said I'd come at 5."],
  ["ar", "قول لقريس إني بتأخر الليلة"],
  ["ar", "قولي للوليا إني أحبها"],
  ["ar", "خلي قريس تجيب الأغراض لغرفتي"],
  ["ar", "قول لقريس إن علي قال إني بجي الساعة ٥"],
  ["tr", "Grace'e söyle bu akşam geç kalacağım"],
  ["tr", "Loulya'ya onu sevdiğimi söyle"],
  ["tr", "Grace'ten odama çantaları getirmesini iste"],
  ["tr", "Grace'e Ali'nin saat 5'te geleceğimi söylediğini söyle"],
];

describe.skipIf(!LIVE)("owner-perspective live extraction evidence (12 calls)", () => {
  const rows: unknown[] = [];

  beforeAll(() => {
    state.realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (() => { throw new Error("NON-PROVIDER NETWORK FORBIDDEN IN EVIDENCE RUN"); }) as typeof fetch;
  });
  afterAll(() => {
    if (state.realFetch) globalThis.fetch = state.realFetch;
    const out = process.env.OWNER_PERSPECTIVE_EVIDENCE_OUT;
    const summary = { calls: state.calls, models: [...new Set(state.models)], rows };
    if (out) writeFileSync(out, JSON.stringify(summary));
    console.log(JSON.stringify({ calls: state.calls, models: summary.models }));
  });

  it("runs each authorized input exactly once through extraction and the local boundary", async () => {
    for (const [n, [language, input]] of INPUTS.entries()) {
      const before = state.calls;
      try {
        const result = await extractItems(input, PEOPLE, OWNER);
        const items = result.extracted.map((it) => {
          const recipient = it.assignedTo && it.assignedTo !== "__me__" ? it.assignedTo : null;
          const recipientText = it.type === "message" ? it.suggestedMessage : it.type === "delegation" ? it.description : null;
          const check = (text: string | null) => (text == null ? null : resolveOwnerPerspective(text, {
            ownerName: OWNER, recipientName: recipient, voice: "composed", declared: it.ownerPerspective,
          }));
          const b = check(recipientText);
          const note = check(it.personalNote);
          return {
            type: it.type, assignedTo: it.assignedTo, ownerPerspective: it.ownerPerspective,
            description: it.description, suggestedMessage: it.suggestedMessage, personalNote: it.personalNote,
            boundary: b && { status: b.status, reason: b.reason },
            noteBoundary: note && { status: note.status, reason: note.reason },
          };
        });
        rows.push({ n: n + 1, language, input, items });
      } catch (err) {
        // A provider/infrastructure failure consumes its call: recorded, never retried.
        rows.push({ n: n + 1, language, input, inconclusive: true, error: String(err).slice(0, 300) });
      }
      expect(state.calls - before, `input ${n + 1} must use exactly one provider call`).toBeLessThanOrEqual(1);
    }
    expect(state.calls).toBeLessThanOrEqual(CALL_CAP);
    expect(new Set(state.models)).toEqual(new Set(state.models.length ? [MODEL] : []));
  }, 600_000);
});
