# ElevenLabs prompt patches

**The live ElevenLabs dashboard prompt is the source of truth.** This repo does not store, maintain, or attempt to reproduce the full prompt — a full copy here would drift from the dashboard and get treated as canonical by mistake.

This directory stores **patches only**: the specific, minimal additions needed when a code change (new client tool, changed tool behavior) requires a matching prompt update. Each patch is a standalone dated file.

## What each patch file contains

- **Tool names** the patch concerns
- **Tool schemas** (params) if a tool is new or changed
- **Behavior rules added** — the actual prompt text
- **Exact section(s) to paste into ElevenLabs**, and where in the live prompt they belong
- **Date**
- **Reason** — what broke or what capability this enables
- **Validation result** — how it was tested, and the outcome

## Rules

- Never paste the full live prompt into this repo.
- Never treat a repo patch file as having taken effect until it's confirmed pasted into the ElevenLabs dashboard.
- Never delete or rewrite sections of the live dashboard prompt from a repo change — patches are additive guidance for a human to paste, not an authoritative replacement.
- One file per change, named `YYYY-MM-DD-short-description.md`.

## Patches

| Date | File | Summary | Status |
|---|---|---|---|
| 2026-08-03 | [2026-08-03-commitment-history.md](2026-08-03-commitment-history.md) | `get_commitment_history` — full evidence-based history of one commitment (Historical Lookup Phase 1, Q4) | **Applied and production-verified 2026-08-04** — see `RA7ETBAL_STATE.md` |
| 2026-08-04 | [2026-08-04-person-history.md](2026-08-04-person-history.md) | `get_person_history` — a person's overall commitment history, outcome counts + recent items (Historical Lookup Phase 2) | **Applied and production-verified 2026-08-10** — see `RA7ETBAL_STATE.md` (corrected here — this row previously said "PENDING", which was stale) |
| 2026-08-11 | [2026-08-11-communication-history.md](2026-08-11-communication-history.md) | `get_communication_history` — chronological communication timeline for a person, read-only, not immutable (Workstream 4, Phase 1) | **PENDING** — code merged; tool not yet registered on the live agent, prompt not yet pasted |
| 2026-08-11 | [2026-08-11-communication-history-actor-attribution.md](2026-08-11-communication-history-actor-attribution.md) | Additive guidance for `get_communication_history`'s answers: preserve historical tense, actor attribution (person/Carson/owner), and date attribution; reframe stored third-person audience wording for the current listener | **PENDING** — awaiting live re-test of "What has Christopher told us?" |
| 2026-08-12 | [2026-08-12-communication-history-system-label-reframing.md](2026-08-12-communication-history-system-label-reframing.md) | Second follow-up for `get_communication_history`: reframe system-generated event labels (not just stored messages) as "you" for the current listener, and anchor each materially different date in its own clause when grouping events | **PENDING** — awaiting live re-test of "What has Christopher told us?" |
| 2026-08-24 | [2026-08-24-attention-summary.md](2026-08-24-attention-summary.md) | `get_items_needing_attention` — grounded, live "what needs my attention" read (Second Brain vertical-slice proof, PR #323) | **PENDING** — code merged-ready; tool not yet registered on the live agent, prompt not yet pasted; no `ELEVENLABS_API_KEY` available in the implementing session |

## Historical patches

These patches are retained only as incident history for surfaces/tools that are no longer active.

| Date | File | Summary |
|---|---|---|
| 2026-07-03 | [archive/2026-07-03-inbox-multi-item.md](archive/2026-07-03-inbox-multi-item.md) | Historical Inbox sequencing patch for removed `act_on_inbox_item` |
