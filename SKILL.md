# Ra7etBal Delivery Skill

Use this skill for every implementation, bug fix, refactor, review, and deployment in this repository.

## 1. Frame the task

Write down:

- User-visible outcome
- Current incorrect behavior
- Expected behavior
- Exact scope
- Explicit non-goals
- Protected nearby behavior
- Risk level
- Best tool or agent for the work

Choose the agent by outcome:

- Claude: architecture, product logic, risk analysis, system design, and architecture-sensitive review
- Codex: focused implementation, tests, commit, push, and deployment
- ChatGPT Work: repository-wide execution, investigation, coordination, and evidence review when appropriate

Do not default to one tool for every task.

## 2. Diagnose before editing

Start with the smallest code path capable of causing the symptom.

Use this order:

1. Reproduce from existing evidence or a focused test.
2. Trace the request or state transition through the relevant functions.
3. Identify the first point where actual behavior diverges from expected behavior.
4. Confirm the root cause with code or test evidence.
5. Only then edit.

Avoid during diagnosis:

- Full test suites
- Production builds
- Broad repository searches after the relevant path is known
- Unrelated refactors
- Speculative rewrites
- Live browser testing unless Sana explicitly requests it

Stop and report when the evidence does not support one clear root cause.

## 3. Implement the smallest safe change

Prefer:

- One root-cause fix over several symptom patches
- Existing patterns over new abstractions
- Deterministic behavior for operational actions
- Shared logic for typed and voice Carson
- Explicit state transitions
- Idempotent writes and duplicate protection
- Truthful failure messages

Do not change product behavior outside the stated outcome.

## 4. Protect nearby behavior

Before editing, list the nearby paths that could regress.

Typical Ra7etBal protections include:

- Voice and typed Carson parity
- Existing Carson tools
- Delegation routing
- Reminders and Automations
- Inbox Review V1
- Notes and To-dos
- Calendar actions
- WhatsApp templates and confirmation links
- Proof upload and Quality Intelligence
- Restored history and selected-image context
- PWA and browser authentication differences

Add regression coverage for the original failure and any high-risk adjacent path.

## 5. Verify efficiently

Run verification in layers:

### Layer A: focused tests

Run only the tests that prove the changed behavior and protected adjacent behavior.

### Layer B: type or lint checks

Run when the changed files or project conventions require them.

### Layer C: production build

Run after implementation is stable, not as an exploratory diagnostic step.

### Layer D: broader suite

Run only when the change affects shared infrastructure, broad state handling, or a release gate.

Never hide failures. Report the exact command and result.

## 6. Maker-checker review

For meaningful changes, separate implementation and review.

The checker must:

- Read the requested outcome and non-goals
- Inspect the exact diff
- Assume the fix may be incomplete
- Look for regressions, races, duplicate actions, stale state, and false success responses
- Confirm that tests would fail without the fix
- Confirm no protected area changed without justification
- Report findings by severity and file

The checker does not approve based only on passing tests.

## 7. Git and worktree rules

Use one branch per task.

Use one Git worktree per concurrently active coding agent.

Suggested branch names:

- `fix/<problem>`
- `feat/<capability>`
- `chore/<maintenance>`
- `docs/<subject>`

Before merging:

- Confirm the branch contains only intended changes
- Confirm no other agent owns the same files
- Rebase or update safely when needed
- Preserve commit evidence

## 8. Completion standard

A normal task is complete only when the relevant items are done:

- Root cause confirmed
- Smallest safe fix implemented
- Focused regression tests added
- Focused tests passed
- Required build or typecheck passed
- Diff reviewed for unrelated changes
- Commit created
- Branch pushed
- PR opened when appropriate
- Deployment completed when requested
- `RA7ETBAL_STATE.md` updated
- Manual production check clearly handed to Sana when required

## 9. Final report template

Use this structure:

### Result
One sentence describing the completed outcome.

### Root cause
The exact point where behavior failed.

### Changes
Files and behavior changed.

### Verification
Commands, test counts, and results.

### Delivery
Commit, branch, PR, and deployment status.

### Manual check
Only the exact live behavior Sana still needs to test.

Do not add filler, future promises, or unsupported claims.
