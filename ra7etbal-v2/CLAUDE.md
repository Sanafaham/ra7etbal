# Ra7etBal — Project Context for Claude Code

**راحة بال** · Mental Load Operating System
Last updated: 2026-06-12

---

## What This Is

Ra7etBal is a Mental Load Operating System, not a task manager.
Carson is the AI Chief of Staff, not a household assistant.
Success = open loops removed from the user's mind, not tasks completed.

---

## Product Structure

**Clear My Head** = Capture and Organize (tasks, reminders, delegations, notes, messages)
- Redirects Carson-style questions (what are you waiting on, what do you know about me) with "Talk to Carson" CTA

**Talk to Carson** = Chief of Staff (memory, notes, waiting-on, priorities, briefings, questions)

---

## NEXT PRIORITY ORDER

1. Meta Template Migration — audit all WhatsApp send paths, activate newest approved templates
2. Google Calendar Integration — beta built, needs final verification (OAuth already configured)
3. Daily Operating Brief V2 — add calendar events, reminders, waiting-on, notes
4. Reminder Push Notifications
5. Notes V2 — Turn Notes Into Action (Note → Task / Delegation / Reminder)
6. Carson Proactive Chief of Staff (Morning Brief, Evening Summary)
7. Carson Access Model V1 (7-day trial, useCarsonAccess() hook)

Multi-Photo V2: DEFERRED until single-photo stable + calendar + daily brief complete.

DO NOT prioritize: relationship memory, transcript systems, OCR, image comparison.

---

## Tech Stack

React 18 + Vite + TypeScript + Tailwind CSS
Zustand state management
Vercel serverless functions (api/*.js) — 12-function Hobby cap, no new routes without removing one
Supabase (Postgres + RLS)
ElevenLabs @elevenlabs/react (Voice Carson)
Anthropic Claude: claude-sonnet-4-6 (extraction), claude-haiku-4-5 (summarize, image describe)
Meta Cloud API (WhatsApp)
Web Push (VAPID)
Upstash QStash (reminders + escalation scheduling)

---

## Core Flows

**Clear My Head:**
`looksLikeQuestion()` check → optional `describeImageForTextCarson()` → Sonnet extraction → Review → `savePending()` → `buildDelegationMessage()` → WhatsApp → QStash

**Voice Carson:**
`ElevenLabsAgentWidget` → `startSession(dynamicVariables, clientTools)` → `onDisconnect` → `summarizeConversation()` → `isSummaryWorthSaving()` gate → `saveSessionMemory()`

**Confirmation:**
WhatsApp → `/confirm` → mark done + proof photo → `/api/confirm-task` → owner push → ConfirmationNotices

---

## Key Files

| File | Purpose |
|------|---------|
| `src/routes/Home.tsx` | Clear My Head — question redirect, image attach, extraction, CTA |
| `src/lib/carson-summarize.ts` | LLM summarization + `isSummaryWorthSaving` quality gate |
| `src/lib/carson-memory.ts` | Session memory save/load — Most recent / Earlier session labels |
| `src/lib/carson-persistent-memory.ts` | Permanent behavioral instructions |
| `src/lib/text-carson.ts` | Text Carson + `describeImageForTextCarson` (exported) |
| `src/lib/delegation-message.ts` | Context-aware delegation messages |
| `src/lib/save.ts` | Save flow — deterministic `buildDelegationMessage` |
| `src/lib/daily-brief.ts` | `buildDailyBrief()` + `buildCarsonSpokenBrief()` |
| `api/send-whatsapp-task.js` | WhatsApp Cloud API delivery |
| `api/confirm-task.js` | Mark done + owner push |
| `src/components/home/ElevenLabsAgentWidget.tsx` | Carson voice UI + client tools + memory pipeline |
| `src/stores/extraction.ts` | Extracted items + `setImageFile` per item |

---

## Supabase Tables

tasks, messages, people, push_subscriptions, carson_memory, carson_facts, carson_persistent_memory, carson_notes, profiles
All RLS: `user_id = auth.uid()`

tasks key columns: image_path (reference), proof_image_path (proof), followup_sent_at, escalated_at

---

## Carson Memory

- `MIN_USER_TURNS = 2` — sessions with 1 user turn skip summarization
- `isSummaryWorthSaving()` — only save if ≥2 bullets OR Correction/Preference/Habit bullet
- Rows labeled: `[Most recent session — Jun 12]` / `[Earlier session — Jun 12]`
- 20 rows retrieved per session

---

## Image Policy (current)

- 1 image per flow (replace-on-select)
- iOS: `<input type="file">` must stay mounted outside status-conditional blocks
- Pipeline: attach → Haiku describe → inject into extractionText → Sonnet extraction → savePending upload → ra7etbal_task_image template

---

## Constraints — Do Not Touch Unless Explicitly Asked

- api/confirm-task.js, api/whatsapp-webhook.js
- WhatsApp template names/params
- Supabase schema
- public/sw.js service worker
- ElevenLabs system prompt (lives in dashboard, not repo)
- Notes, Calendar, Reminders, Memory, Escalation — do not touch unless tasked

---

## Security Rules

- Secrets never in logs or terminal output
- google_refresh_token: server-only always, never returned to client
- Google Calendar scope: https://www.googleapis.com/auth/calendar.readonly

---

## Development Rules

- Do not rebuild working systems
- Make targeted changes only
- Verify architecture before modifying code
- Prioritize stability over new features
- Mobile experience is critical
- Mental load reduction is the primary product goal

---

## PERMANENT RA7ETBAL SAFETY ENGINEERING STANDARD

### RA7ETBAL TOKEN AND TIME BUDGET RULE

Primary objective:
Preserve enough tokens and time to complete the task end to end.

Completion has priority over narration, repeated investigation, and procedural ceremony.

**1. READ ONCE**

Read the required project documents and relevant code once.
Do not repeatedly reread the same files unless a specific inconsistency requires it.

**2. INVESTIGATE WITH A LIMIT**

Identify the root cause before editing, but keep investigation focused.

For a normal bug:
- Inspect the affected path
- Inspect the source of truth
- Inspect nearby duplicate or fallback paths
- Then implement

Do not perform a broad repository audit unless the task requires it.

**3. IMPLEMENT EARLY**

Once the root cause is confirmed, begin the fix.
Do not spend most of the context window planning or narrating before implementation.

**4. MINIMAL PROGRESS UPDATES**

Do not narrate every command, file read, wait, or thought.

Only report:
- A genuine blocker
- A risky decision requiring approval
- A material change in direction
- Final evidence

**5. TARGETED TESTS DURING DEVELOPMENT**

After implementation and small review fixes, run only the relevant targeted tests.
Do not run the entire suite and build after every minor edit.

**6. FULL VALIDATION MAXIMUM**

For normal low-risk work:
- One full validation before the PR
- One final full validation after all legitimate review findings are fixed

Do not exceed two full validation cycles unless a serious regression, security issue, data-integrity issue, or architectural change requires it.

**7. BATCH REVIEW FINDINGS**

Wait for CodeRabbit to complete its review.
Collect all legitimate findings.
Fix them in one batch.
Do not enter repeated fix, full-test, push, wait cycles for each trivial comment.

**8. REVIEW ROUND LIMIT**

For normal work:
- One initial review
- One final re-review

If the final re-review contains only low-risk style, naming, test-cleanup, or documentation comments, merge without another review cycle after targeted verification.

Continue additional review rounds only for:
- Security
- Authentication
- Database integrity
- Duplicate execution
- Secret exposure
- Production configuration
- Destructive behavior
- Major architecture risks

**9. NO ACTIVE POLLING**

Do not repeatedly check CodeRabbit or deployment status every few minutes while consuming tokens.
Use a reasonable wait, then check once.

**10. RESERVE COMPLETION BUDGET**

Before beginning, reserve enough budget for:
- Implementation
- Tests
- Review fixes
- Commit and push
- Merge
- Deployment verification
- Production test
- Final evidence report

If the remaining budget becomes limited, reduce narration and optional investigation first.
Never sacrifice implementation or production verification to preserve commentary.

**11. STOP CONDITIONS**

Pause only for:
- Human approval on a genuinely risky change
- Required login or browser authorization
- Missing secret or external credential
- An unclear product decision that changes behavior
- A real technical blocker

Do not pause for routine coding decisions.

**12. FINAL REPORT ONLY**

The final report should contain:
- Root cause
- Fix
- Files changed
- Tests run
- Commit or PR
- Deployment status
- Production verification
- Remaining risk

Do not produce repeated long interim reports.

### RA7ETBAL TOKEN AND TIME BUDGET RULE UPDATE

Add the following to the existing rule.

Applies by default unless the task explicitly requires:

- Deep research
- Architecture design
- Security review
- Authentication review
- Database design
- Major refactor
- Production-risk assessment

**ONE-PASS DEFAULT**

For normal low-risk Ra7etBal work:

DISCOVER → Identify root cause
EXECUTE → Implement safest fix
VERIFY → Run targeted tests
REVIEW → CodeRabbit review
FIX → Batch legitimate findings
VALIDATE → Final validation
DEPLOY → Production verification
REPORT → Evidence

Do not split normal work into investigation-only phases.
Complete the task end-to-end unless a Stop Condition is reached.
Success is a verified outcome, not a completed investigation.

### SUCCESS DEFINITION

A task is successful only when the requested behavior is fixed, verified, deployed where relevant, and reported with evidence.

A long investigation without completion is not success.
A fully tested PR that is never merged is not success.
A merged change that is not verified in production is not success.
