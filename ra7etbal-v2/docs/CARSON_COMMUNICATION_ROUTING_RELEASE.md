# Carson communication-routing protected release contract

Last production verification: 2026-07-30  
Verified baseline merge: `29aae0f685d18ed79e8548d565fb77649a538706` (PR #131)

## Exact production evidence

Confirmed live:

- A plain communication request sent successfully.
- `Ask Sana to reply yes on WhatsApp.` preserved its meaning as `Please reply
  yes on WhatsApp.`
- Exactly one outbound WhatsApp was sent.
- Carson truthfully reported `Sent to Sana.`

Not yet confirmed by live production diagnostics:

- A `legacy_people_tool_redirected` execution.
- A successful `people_action_mapped` / `route_people_action` execution.
- A `duplicate_suppressed` event.

Those mechanisms are protected by code/CI tests but must not be described as
production-verified until a controlled live diagnostic proves each path.

## Diagnostics migration history

The production columns and stage constraint from
`20260801_carson_communication_routing_diagnostics.sql` were verified after the
SQL was applied manually in the Supabase dashboard. The repository contains
the matching additive migration file, but this corrective pass could not
authenticate to the production migration ledger and found no linked local
Supabase CLI state. Therefore the schema is working, but the migration-history
row is not claimed as reconciled.

Do not re-run the migration or insert a `schema_migrations` row by hand. A
future bookkeeping repair must first read the authenticated production ledger
and use the project's normal linked migration tooling so it cannot falsely
record a version that differs from the SQL already applied.

## Canonical rule

For new person-directed requests, Carson must call `route_people_action`.

- `interpersonal_communication` executes `send_direct_whatsapp_message`.
- `tracked_delegation` executes `send_delegation`.
- `send_direct_whatsapp_message` and `send_delegation` remain registered as
  internal execution/rollback tools, not competing model-facing choices.
- Plain communication includes `send [person] a message`, `tell [person]
  [content]`, `let [person] know [content]`, and `ask/tell/have/get [person]
  to reply/respond/say/confirm [content]`.
- Genuine assigned work remains a delegation.
- Ambiguous or incomplete requests clarify; they never guess and execute.
- Meaning is preserved. `Ask Sana to reply yes on WhatsApp.` sends `Please
  reply yes on WhatsApp.`, never only `yes`.
- One request reaches at most one outbound handler. The existing direct-message
  duplicate guard runs on the normalized message before the only delivery call.
- Carson reports success only after the existing handler confirms acceptance;
  otherwise it reports that the message was not sent.

This file is the repository-owned rule. The live ElevenLabs dashboard remains
the production prompt/tool source of truth, so parity with this rule is a
manual release gate rather than an automated CI publication.

## ElevenLabs parity check

Before publishing any related prompt or tool-description change, confirm:

- `route_people_action` says it is the only model-facing tool for a new
  person-directed request.
- `send_direct_whatsapp_message` says it is internal execution/rollback and
  describes the locked communication forms.
- `send_delegation` says it is internal execution/rollback and only for real
  work whose completion is tracked.
- The production prompt contains the same communication/delegation distinction,
  requires meaning preservation, and forbids success claims before tool
  confirmation.
- No other prompt section contradicts those rules.

Do not publish ElevenLabs changes automatically from CI.

## Required Sana-only production smoke test

Run this checklist after any change touching the ElevenLabs prompt, tool
descriptions, communication/delegation routing, direct WhatsApp execution,
transcript handling, or duplicate prevention:

1. Compound boundary (Sana-only):
   `Ask Sana to reply yes if she can come tomorrow, then tell Sana to order
   more chairs.`
   Expected: exactly one outbound to Sana containing only
   `Please reply yes if she can come tomorrow.`; no second message, task, or
   delegation.
2. Ordinary message: `Tell Sana the delivery arrived.`
3. Meaning-preserving reply: `Ask Sana to reply yes on WhatsApp.`
4. Genuine assignment classification: `Ask Christopher to buy olive oil.`
   Do not execute/send this delegation unless that separate live action is
   explicitly authorized; classification-only evidence is sufficient.
5. Confirm exactly one outbound action for each authorized communication.
6. Confirm Carson's spoken and displayed result matches the real delivery.
7. Confirm diagnostics show the utterance hash, model-selected tool, any
   redirect reason, final handler, normalized-message hash, acceptance/failure,
   delivery/transport identifier when accepted, and duplicate outcome.

## Rollback record

- Last known good deployed code: PR #133 at merge
  `d8b9f84dc2f0024267ca402d3389a58f535b9bda`.
- Production deployment:
  `dpl_5r6rFbJKpF6wapt7W8Bo7XWYRHG3` (`READY`, commit-matched).
- PR #131 remains the last live-message-verified baseline; PR #133's
  compound-boundary behavior still requires the controlled Sana-only retest
  below before it may be called production-message-verified.
- Verified phrase: `Ask Sana to reply yes on WhatsApp.`
- Verified result: one direct WhatsApp, `Please reply yes on WhatsApp.`, truthful
  `Sent to Sana.`, no intended delegation/task.
- Affected runtime files:
  - `src/components/home/ElevenLabsAgentWidget.tsx`
  - `src/lib/carson-people-action.ts`
  - `src/lib/carson-tool-policy.ts`
  - `src/lib/communication-vs-delegation.ts`
  - `src/lib/direct-message-duplicate-guard.ts`
  - `src/lib/carson-tool-diagnostics.ts`
- Prompt/tool record:
  `docs/elevenlabs-prompt-patches/2026-07-30-route-people-action.md`.
- Quickest safe rollback: restore the stable tagged commit, deploy it, and
  restore the matching live ElevenLabs prompt/tool descriptions recorded by
  this contract. Do not remove the legacy execution tools.
- After rollback, rerun the three Sana-only smoke checks above and inspect
  diagnostics before declaring recovery.

Corrective stable tag:
`ra7etbal-stable-carson-compound-communication-boundary-2026-07-30`.
It immutably targets PR #133's deployed merge commit; use `git rev-list -n 1
ra7etbal-stable-carson-compound-communication-boundary-2026-07-30` to resolve
it. The earlier `ra7etbal-stable-carson-communication-routing-2026-07-30` tag
was not moved.
