/**
 * Live-model evidence for the tracked-delegation content boundary and C-02
 * routing (the same gate C-02 used: real claude-haiku-4-5 calls, recorded).
 *
 * Uses the EXACT production prompt, parser and deterministic grounding from
 * src/lib/communication-vs-delegation.ts — only the transport differs (direct
 * Anthropic API instead of the authenticated /api/anthropic proxy).
 * Read-only: no database, no WhatsApp, no app state.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... VITE_SUPABASE_URL=http://localhost VITE_SUPABASE_ANON_KEY=x \
 *     npx vite-node scripts/staff-instruction-live-evidence.ts -- --runs 3
 * Exit code 0 only when every run of every case matches.
 */
import {
  STAFF_INSTRUCTION_MAX_TOKENS,
  STAFF_INSTRUCTION_MODEL,
  buildClassificationPrompt,
  groundRecipientInstruction,
  isReportedThirdPartyDesire,
  parseStaffInstructionAnswer,
} from "../src/lib/communication-vs-delegation";

type Expected =
  | { kind: "communication" }
  | { kind: "delegation"; recipient: string };

// Owner utterance, recipient, expected outcome.
const CASES: Array<[string, string, Expected]> = [
  // Owner → Carson management language must be left out.
  ["Ask Christopher to prepare lunch for me and track this until he confirms it.", "Christopher", { kind: "delegation", recipient: "prepare lunch for me" }],
  ["Track this for me: ask Christopher to prepare lunch.", "Christopher", { kind: "delegation", recipient: "prepare lunch" }],
  ["Ask Christopher to prepare lunch, and once he confirms, remind me to call Grace.", "Christopher", { kind: "delegation", recipient: "prepare lunch" }],
  ["Make sure this gets tracked — ask Christopher to prepare lunch.", "Christopher", { kind: "delegation", recipient: "prepare lunch" }],
  // Legitimate recipient work must stay whole.
  ["Ask Christopher to follow up with the butcher about the salmon.", "Christopher", { kind: "delegation", recipient: "follow up with the butcher about the salmon" }],
  ["Ask Christopher to track the grocery delivery.", "Christopher", { kind: "delegation", recipient: "track the grocery delivery" }],
  ["Ask Christopher to make sure the oven is turned off.", "Christopher", { kind: "delegation", recipient: "make sure the oven is turned off" }],
  ["Ask Christopher to confirm the florist booking.", "Christopher", { kind: "delegation", recipient: "confirm the florist booking" }],
  ["Ask Christopher to prepare lunch and tell Grace it is ready.", "Christopher", { kind: "delegation", recipient: "prepare lunch and tell Grace it is ready" }],
  ["Ask Christopher to check the pool pump.", "Christopher", { kind: "delegation", recipient: "check the pool pump" }],
  // C-02 authoritative routing (must be unchanged).
  ["Ask Christopher to bring the car around at 6.", "Christopher", { kind: "delegation", recipient: "bring the car around at 6" }],
  ["Ask Grace to call me.", "Grace", { kind: "delegation", recipient: "call me" }],
  ["Ask Christopher to make the pizza.", "Christopher", { kind: "delegation", recipient: "make the pizza" }],
  ["Tell Christopher to wait in the kitchen for me.", "Christopher", { kind: "communication" }],
  ["Christopher, come to the kitchen now.", "Christopher", { kind: "communication" }],
  ["Tell Grace dinner is at eight.", "Grace", { kind: "communication" }],
  ["Tell Christopher to meet me outside.", "Christopher", { kind: "communication" }],
  ["Tell Loulya I would like her to call me.", "Loulya", { kind: "communication" }],
];

async function callModel(utterance: string, recipient: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: STAFF_INSTRUCTION_MODEL,
      max_tokens: STAFF_INSTRUCTION_MAX_TOKENS,
      messages: [{ role: "user", content: buildClassificationPrompt(utterance, recipient) }],
    }),
  });
  const body = (await res.json()) as { content?: Array<{ text?: string }>; error?: unknown };
  if (!res.ok || body.error) throw new Error(`model call failed: ${res.status} ${JSON.stringify(body.error ?? "")}`);
  return body.content?.[0]?.text ?? "";
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?]+$/g, "").trim();
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — no live evidence was produced.");
    process.exit(2);
  }
  const runsFlag = process.argv.indexOf("--runs");
  const runs = runsFlag > -1 ? Number(process.argv[runsFlag + 1]) || 3 : 3;
  let failures = 0;
  let total = 0;
  for (const [utterance, recipient, expected] of CASES) {
    for (let run = 1; run <= runs; run += 1) {
      total += 1;
      let outcome: string;
      if (isReportedThirdPartyDesire(utterance)) {
        outcome = "communication (deterministic)";
      } else {
        const raw = await callModel(utterance, recipient);
        const parsed = parseStaffInstructionAnswer(raw);
        if (parsed.failed) outcome = `UNSAFE unparseable: ${JSON.stringify(raw)}`;
        else if (parsed.classification === "communication") outcome = "communication";
        else {
          const grounded = groundRecipientInstruction(parsed.recipientSpan, utterance, recipient);
          outcome = grounded ? `delegation: ${grounded}` : `UNSAFE ungrounded: ${JSON.stringify(parsed.recipientSpan)}`;
        }
      }
      const ok =
        expected.kind === "communication"
          ? outcome.startsWith("communication")
          : outcome.startsWith("delegation: ") && normalize(outcome.slice(12)) === normalize(expected.recipient);
      if (!ok) failures += 1;
      console.log(`${ok ? "PASS" : "FAIL"} [${run}/${runs}] ${JSON.stringify(utterance)} → ${outcome}`);
    }
  }
  console.log(`\n${total - failures}/${total} matched (${STAFF_INSTRUCTION_MODEL}).`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
