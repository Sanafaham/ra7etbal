# Carson direct-message truthfulness and reply-routing patch

**Date:** 2026-07-29
**Agent:** CARSON (`agent_3001kt3zzkcxfb3bwejd8yzzhnmy`)
**Code contract:** `src/lib/carson-tool-policy.ts`, `src/lib/communication-vs-delegation.ts`, `src/lib/carson-direct-tool-override.ts`
**Application status:** APPLIED — pasted by Sana directly into the live ElevenLabs dashboard (at the end of the main Carson system prompt) and published. See [2026-07-29-action-routing-contradiction-cleanup.md](2026-07-29-action-routing-contradiction-cleanup.md) for a conflict found during that review and its cleanup.

## Reason

Two confirmed production incidents on 2026-07-29, both traced to root cause with production evidence (Supabase, Vercel logs, and the ElevenLabs conversation dashboard):

1. **False "sent" claim with no real send** (fixed in code, PRs #106/#108): Carson displayed "Message sent to Christopher." / "Sent to Christopher." for "Ask Christopher to reply, 'Test received.'..." with zero `messages`/`whatsapp_deliveries` rows and zero transport requests. The client-side code now truthfully overrides this class of fabricated claim regardless of cause (`detectsUnconfirmedMessageSendClaim`).
2. **Misrouted tool selection** (fixed in code): the deterministic tool-policy gate rejected `send_direct_whatsapp_message` for this exact phrasing because the router classified "Ask Christopher to reply..." as tracked delegation, not plain communication — the rejection happened in ~0ms with no network call, which is what let the false claim above go unnoticed by any transport-level check.

The code-level fixes are the enforcement layer and do not depend on this prompt patch. This patch is a complementary, best-effort reinforcement so the model's own reasoning is less likely to attempt the wrong tool or narrate an unearned outcome in the first place — it cannot substitute for the deterministic gate or the truthfulness override, and must never be treated as sufficient on its own.

## Additive system-prompt section

Add this section without deleting or replacing unrelated Carson instructions. If a "DETERMINISTIC TOOL PRECEDENCE" section from the 2026-07-29 tool-policy patch is already present, add this as a new subsection immediately after it rather than a separate block.

```text
DIRECT COMMUNICATION AND EXECUTION TRUTHFULNESS

Mentioning a person's name, or being asked to relay something to them, is a request for you to act — it is never itself proof that an action already happened.

1. "Ask/tell/have/get [name] to reply/respond/say/confirm [content]" is plain communication, not tracked delegated work — use send_direct_whatsapp_message, never execute_instruction or send_delegation, regardless of which verb introduces it ("ask", "tell", "message", "have", "get").
2. Never state or imply that a message was sent, delivered, received, or that a task was created unless the corresponding tool call actually returned a result confirming that outcome. A tool call that was rejected, blocked, or returned a clarification question is not a success — relay its result truthfully, exactly as returned, even if that means saying the action did not happen yet.
3. If you did not call a tool this turn, you have not sent anything, delegated anything, or created anything — say so plainly rather than describing an outcome.
4. "Ask/tell/message [name] [something]" phrasing must resolve to the same tool choice regardless of surface wording (ask vs. tell vs. message vs. have vs. get) — the deciding factor is whether the content is plain communication or trackable operational work, never which verb was used.
```

## Verification steps (before pasting)

1. Read the live agent's current prompt and record its version ID and a hash of the exact prompt text.
2. Confirm the section above does not already exist (avoid duplicating).
3. Paste the section additively, in the location noted above.
4. Read the agent back and confirm: the new section appears exactly once, all unrelated prompt content is byte-for-byte unchanged, and no tool schema was altered.
5. Record the new version ID here once applied.

## Live verification record

Applied by Sana on 2026-07-29: pasted at the end of the main Carson system prompt and published. No version ID or before/after hash was recorded by this task (applied directly through the dashboard UI, not via API read-back) — if a future task has API access, confirm the section exists exactly once and no unrelated content changed.

During this same review, Sana found and reported a pre-existing contradiction elsewhere in the live prompt ("ACTION ROUTING — REQUIRED" instructed `send_delegation` for phrasing already confirmed as communication elsewhere in this same prompt and in the codebase) — see [2026-07-29-action-routing-contradiction-cleanup.md](2026-07-29-action-routing-contradiction-cleanup.md).
