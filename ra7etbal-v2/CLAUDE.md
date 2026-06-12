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
