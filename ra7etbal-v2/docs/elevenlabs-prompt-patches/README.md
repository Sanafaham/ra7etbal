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

| Date | File | Summary |
|---|---|---|
| 2026-07-03 | [2026-07-03-inbox-multi-item.md](2026-07-03-inbox-multi-item.md) | Multi-item Inbox instruction sequencing + delegate-vs-message wording for `act_on_inbox_item` |
