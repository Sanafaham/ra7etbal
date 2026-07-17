# Ra7etBal Agent Operating System

This file is the mandatory entry point for every AI agent working in this repository.

Read these files before changing code:

1. `AGENTS.md`
2. `SKILL.md`
3. `RA7ETBAL_STATE.md`
4. The files and focused tests directly related to the task

Do not begin implementation until the outcome, scope, protected behavior, and verification plan are clear.

## Product identity

Ra7etBal is a personal Chief of Staff that reduces mental load. It is not a generic task manager.

Carson is the AI Chief of Staff inside Ra7etBal. Voice Carson and typed Carson are the same person. They must follow the same rules, use the same tools, preserve the same context, and produce the same operational outcomes.

Reliability is more important than feature count.

## Permanent delivery rules

For every task:

1. Define the exact user-visible outcome.
2. Identify the smallest likely root cause before editing.
3. Constrain the scope to the relevant code path.
4. State what must not be changed.
5. Protect nearby stable behavior.
6. Implement the smallest safe fix.
7. Add or update focused regression tests.
8. Run focused verification first.
9. Run broader verification only when justified by the change.
10. Commit, push, and deploy when the task calls for it.
11. Report evidence, not confidence.

Do not perform broad exploration, broad refactors, full test suites, or production builds during diagnosis unless the task requires them.

Stop and report before expensive verification when the root cause remains uncertain.

## Approval boundaries

Proceed without waiting for approval for normal, reversible, low-risk work.

Stop for approval before:

- Database schema changes or destructive migrations
- Authentication or authorization changes
- Payments or billing changes
- Destructive data actions
- New or changed WhatsApp templates
- Irreversible production actions
- Product decisions that are genuinely unclear

## Live testing boundary

Do not instruct Codex or another coding agent to perform live production UI testing, browser authentication, cookie inspection, session inspection, or user-flow testing unless Sana explicitly asks.

The normal stopping point is:

- Code complete
- Focused tests complete
- Commit created
- Branch pushed
- Deployment complete when required
- Evidence reported

Sana performs the live production test. Logs may be inspected afterward when requested.

## Parallel work safety

Two agents must not edit the same working directory at the same time.

When work runs in parallel:

- Give each agent its own branch and Git worktree.
- Give each agent a non-overlapping scope.
- Name the owner of each file or subsystem.
- Do not allow two agents to modify the same files unless one is explicitly reviewing rather than editing.
- Merge only after focused verification and review.

Recommended pattern:

- Maker: implements the change and focused tests.
- Checker: assumes the change is broken, reviews the diff, tests assumptions, and reports concrete risks.

The checker should not silently rewrite the maker's work. It should report findings or make a separately scoped fix.

## Protected behavior

Do not reopen or modify protected areas without a reproduced regression or an explicit product decision.

Current protected areas are listed in `RA7ETBAL_STATE.md`.

At minimum, protect:

- Inbox Review V1 behavior
- Completed recurring owner reminder fixes
- Type to Carson and Talk to Carson parity
- Typed-image delegation safeguards
- Quality Intelligence V1 completion and correction flow
- Normal delegations, proof upload, worker replies, reminders, Notes, and Calendar behavior when working nearby

## Truth and evidence

Never claim a test passed unless it was run.

Never claim production is fixed until Sana verifies the live behavior or there is direct production evidence.

Final reports must include:

- Exact root cause
- Exact files changed
- Focused tests run and results
- Broader checks run and results
- Commit SHA
- Branch or PR
- Deployment status when applicable
- Remaining manual test, if any

If something cannot be confirmed, say so directly.

## State maintenance

`RA7ETBAL_STATE.md` is the repository source of truth for completed, protected, blocked, and next work.

Every task that changes project status must update it in the same branch before completion.

Do not turn it into a diary. Keep it concise, current, and operational.
