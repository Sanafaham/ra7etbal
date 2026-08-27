# ElevenLabs Prompt Patch — Notes / To-do routing closure

**Date:** 2026-08-27  
**Scope:** `save_note`, `create_todo`, `complete_todo`, `act_on_note` only  
**Status:** NOT YET APPLIED — apply as a minimal additive/replacement patch to Production Carson; do not replace the full prompt.

## Tool-description clarification

For `act_on_note`, use this description:

```text
Acts on one note that is already saved in Ra7etBal Notes. This tool does not read a currently attached image and must not be used merely because the owner calls an attachment “this note.” Use it only when the owner refers to an existing saved note and wants that note turned into a task/action, reminder, calendar event, or delegation. Pass query as distinctive words from the saved note's actual content, never a pronoun such as “it,” “this note,” “that note,” or “note I have.” If the note cannot be identified from the current conversation, ask which saved note the owner means. The backend will ask for clarification on zero or multiple matches and must never guess.
```

Keep the existing schema unchanged:

- `query`: required string
- `action`: required enum `task | reminder | delegate | calendar`
- `time_text`: optional string, required by reminder/calendar
- `person_name`: optional string, required by delegate

## Minimal prompt replacement

In the existing Notes / To-do routing section, preserve surrounding text and replace only the overlapping routing rules with:

```text
NOTES AND TO-DO — REQUIRED DISTINCTION
A note is information, an idea, a thought, reference material, or something the owner wants to remember without making it an active commitment. “Remember that I want to try X” and “I have an idea for X” are notes: call save_note. A to-do is an action the owner needs to perform. “Add buy batteries” and “Buy batteries” are to-dos: call create_todo.

When the owner says an existing to-do is finished, call complete_todo with distinctive words from that to-do. Never claim completion unless the tool confirms it. If the tool reports zero or multiple matches, relay its clarification and do not mutate anything.

act_on_note is ONLY for a note already saved in Ra7etBal Notes. It is not an image-reading tool. For “remind me about that note,” “ask Christopher about that note,” or “put that note on my calendar,” resolve which saved note is meant from the current conversation and pass distinctive words from its actual saved content as query. Never pass “that note,” “this note,” “it,” or “note I have” as query. If the saved note is not identifiable, ask one short clarification. Do not create another copy of the note.

After any Notes/To-do tool call, use the returned result as authoritative. No tool success means no success claim.
```

## Non-goals

- No full-prompt rewrite.
- No change to reminder, calendar, delegation, WhatsApp, hosting, Stage 2A, MCP, or unrelated tool registrations.
- No attached-image orchestration change; an attached handwritten note belongs to the separate compound multimodal `execute_instruction` boundary.

## Rollback

Restore the immediately preceding immutable ElevenLabs agent version or reverse only the tool-description and Notes/To-do prompt text above. Repository runtime changes are independently reversible by reverting their merge commit.
