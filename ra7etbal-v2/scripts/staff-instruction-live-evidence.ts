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
  | { kind: "delegation"; recipient: string }
  // Genuinely ambiguous ownership: the whole instruction or a fail-closed
  // "nothing sent" are both safe; dropping the second action is not.
  | { kind: "delegation_or_unsafe"; recipient: string };

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
  // Coordinated actions all assigned to the recipient must stay whole
  // (live gate run 36768330026 dropped "tell Grace it is ready").
  ["Ask Christopher to call the butcher and tell me what he says.", "Christopher", { kind: "delegation", recipient: "call the butcher and tell me what he says" }],
  ["Ask Christopher to collect the package and put it in my room.", "Christopher", { kind: "delegation", recipient: "collect the package and put it in my room" }],
  ["Ask Christopher to check the delivery and call the driver if it is late.", "Christopher", { kind: "delegation", recipient: "check the delivery and call the driver if it is late" }],
  // Ambiguous ownership: never silently reduced to the first action.
  ["Ask Christopher to follow up with the butcher and let me know what he says.", "Christopher", { kind: "delegation_or_unsafe", recipient: "follow up with the butcher and let me know what he says" }],
  ["Ask Christopher to book the restaurant and let me know the time.", "Christopher", { kind: "delegation_or_unsafe", recipient: "book the restaurant and let me know the time" }],
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

/** Per-call ceiling; a slower answer counts as an ERRORED run, never dropped. */
const CALL_TIMEOUT_MS = 30_000;

async function callModel(utterance: string, recipient: string): Promise<{ text: string; stopReason?: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
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
  const body = (await res.json()) as {
    content?: Array<{ text?: string }>;
    error?: { type?: string; message?: string };
    stop_reason?: string;
  };
  // Only the provider's error type and its own error message are reported —
  // never request headers or the key. The message is server-written text; as
  // a belt-and-braces guard any occurrence of the key is redacted and it is
  // capped at 300 characters.
  if (!res.ok || body.error) {
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    const message = (body.error?.message ?? "").split(key || "\u0000").join("[redacted]").slice(0, 300);
    throw new Error(`model call failed: HTTP ${res.status} ${body.error?.type ?? ""} ${JSON.stringify(message)}`.trim());
  }
  return { text: body.content?.[0]?.text ?? "", stopReason: body.stop_reason };
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
  // Minimum 3 independent runs per phrase (the owner's pass standard).
  const runs = Math.max(3, runsFlag > -1 ? Number(process.argv[runsFlag + 1]) || 3 : 3);
  // Every attempted run is in the denominator: model errors/timeouts and
  // malformed answers are counted and fail the gate, never skipped.
  let attempted = 0;
  let completed = 0;
  let correct = 0;
  let malformed = 0;
  let errored = 0;
  for (const [utterance, recipient, expected] of CASES) {
    for (let run = 1; run <= runs; run += 1) {
      attempted += 1;
      let outcome: string;
      if (isReportedThirdPartyDesire(utterance)) {
        completed += 1;
        outcome = "communication (deterministic, no model call)";
      } else {
        let answer: { text: string; stopReason?: string } | null = null;
        try {
          answer = await callModel(utterance, recipient);
        } catch (error) {
          errored += 1;
          outcome = `ERROR ${(error as Error).name === "TimeoutError" ? "timeout" : (error as Error).message}`;
        }
        if (answer) {
          completed += 1;
          const parsed = answer.stopReason === "max_tokens" ? null : parseStaffInstructionAnswer(answer.text);
          if (!parsed || parsed.failed) {
            malformed += 1;
            outcome = `MALFORMED ${JSON.stringify(answer.text)}`;
          } else if (parsed.classification === "communication") {
            outcome = "communication";
          } else {
            const grounded = groundRecipientInstruction(parsed.recipientSpan, utterance, recipient);
            outcome = grounded
              ? `delegation: ${grounded}`
              : `unsafe (nothing sent): model span ${JSON.stringify(parsed.recipientSpan)}`;
          }
        }
      }
      const exactRecipient =
        expected.kind !== "communication" &&
        outcome!.startsWith("delegation: ") &&
        normalize(outcome!.slice(12)) === normalize(expected.recipient);
      const ok =
        expected.kind === "communication"
          ? outcome!.startsWith("communication")
          : expected.kind === "delegation"
            ? exactRecipient
            : exactRecipient || outcome!.startsWith("unsafe (nothing sent)");
      if (ok) correct += 1;
      console.log(`${ok ? "PASS" : "FAIL"} [${run}/${runs}] ${JSON.stringify(utterance)} → ${outcome!}`);
    }
  }
  console.log(
    `\nattempted=${attempted} completed=${completed} correct=${correct} malformed=${malformed} errored=${errored} (${STAFF_INSTRUCTION_MODEL})`,
  );
  const pass = attempted > 0 && correct === attempted;
  console.log(pass ? "LIVE-MODEL GATE: PASS" : "LIVE-MODEL GATE: FAIL");
  process.exit(pass ? 0 : 1);
}

void main();
