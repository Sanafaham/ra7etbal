# Ra7etBal startup instructions

These instructions are mandatory for Claude Code and any Claude agent working in this repository.

Before investigating, editing, testing, or planning work, read these files in order:

1. `AGENTS.md`
2. `SKILL.md`
3. `RA7ETBAL_STATE.md`

Do not change code before reading them.

Use them as the repository source of truth for:

- product intent
- protected and completed behavior
- current priorities and blockers
- diagnosis and implementation rules
- testing and deployment requirements
- approval boundaries
- worktree and parallel-agent safety
- maker-checker review
- completion evidence

Before each task:

1. Define the exact outcome.
2. Choose the best tool or agent for the work based on safety, speed, and verification quality.
3. Find the smallest root cause before broad investigation.
4. Protect all nearby stable behavior.
5. Stop and report before any risky, destructive, unclear, or approval-gated action.

During work:

- Do not reopen completed work without a reproduced regression.
- Do not use broad test suites or production builds during diagnosis unless needed.
- Do not perform live production UI testing, browser authentication, cookie inspection, session inspection, or user-flow testing unless Sana explicitly asks.
- Use a separate branch and worktree when another agent may work in parallel.
- Do not let the same agent be the only judge of a meaningful change when independent review is available.

At completion:

1. Run focused tests first.
2. Run broader validation only when justified.
3. Commit and push the finished work when appropriate.
4. Deploy when the task requires it and no approval gate blocks it.
5. Report exact evidence, including files changed, tests run, commit, deployment status, risks, and anything not verified.
6. Update `RA7ETBAL_STATE.md` whenever the project status, protected behavior, blocker, priority, or verified completion has changed.

Never claim that work is complete without evidence.
