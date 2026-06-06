# Ra7etBal — Skill Reference

**راحة بال** · Mental Relief Assistant  
Solofounder PWA. Current state as of June 2026.

---

## What It Is

Ra7etBal is a personal chief-of-staff PWA for busy households. It helps one person — the owner — offload mental load: delegate tasks, set reminders, follow up with household staff, and get a spoken daily brief from an AI voice assistant called Carson.

The product is calm by design. No notifications that aren't actionable. No social features. No public-facing profiles. One owner per account.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS |
| State | Zustand (tasks, people, profile, messages, extraction, draft, auth) |
| Backend | Vercel serverless functions (`/api/*.js`) |
| Database | Supabase (Postgres + Row Level Security) |
| Auth | Supabase Auth (email + password, no email confirmation) |
| Voice AI | ElevenLabs `@elevenlabs/react` Conversation SDK |
| AI Extraction | Anthropic Claude (`claude-haiku-4-5` via `/api/anthropic` proxy) |
| WhatsApp | Meta Cloud API (Business template messages) |
| Push Notifications | Web Push (VAPID) via `web-push` |
| Reminder Scheduling | Upstash QStash (exact-time job delivery) |
| PWA | Vite PWA plugin, `manifest.json`, service worker |

---

## Core Concepts

### Task Types

Eight extraction types defined in `src/types/extraction.ts`:

| Type | Meaning |
|---|---|
| `action` | Owner needs to do something — clear next step |
| `reminder` | Time-based or to-be-remembered item |
| `message` | One-way communication, no follow-up needed |
| `delegation` | Assign someone else to do and confirm |
| `decision` | Unresolved choice |
| `followup` | Waiting on someone or something |
| `errand` | Shopping, pickup, errand |
| `parked` | Idea for later — not yet actionable, skipped at save |

### Task Status

`pending` → `done` or `cancelled`

Status is only changed by:
- The recipient clicking the confirmation link (`/api/confirm-task`)
- The owner tapping "Mark done" in the UI

New tasks always start as `pending`. A defensive server-side check corrects any column default that flips this.

### People

Stored in `people` table. Each person has: `name`, `role` (Driver, Nanny, Cook, etc.), `phone`. Phone is required for WhatsApp delegation. RLS: owner sees only their own contacts.

---

## Input Flows

### 1. Typed Input (Ask Ra7etBal)

```
Home textarea
  → LLM extraction via /api/anthropic (claude-haiku-4-5)
  → ExtractedItem[] displayed on /review
  → Owner approves/edits
  → savePending() → tasks + messages tables
  → If delegation → WhatsApp message sent via /api/send-whatsapp-task
  → If reminder → QStash job scheduled via /api/qstash-reminder
```

Owner pronouns in delegated messages are rewritten at save time:
`rewriteOwnerPronouns(text, ownerName)` — "call me" → "call Sana"

### 2. Voice Input (Carson)

```
ElevenLabsAgentWidget
  → Conversation.startSession() with dynamicVariables + clientTools
  → Carson speaks / listens
  → Client tools execute server-side actions directly:
      send_delegation → WhatsApp + task row
      send_followup   → WhatsApp + followup task row
      create_reminder → task row + QStash schedule
  → onDisconnect → summarizeConversation() → saveSessionMemory()
```

---

## Carson — Voice Assistant

### Dynamic Variables (injected at session start)

| Variable | Content |
|---|---|
| `ra7etbal_state` | Structured data: people, reminders, needs-attention, waiting, completed, later |
| `daily_brief` | Pre-built spoken paragraph for when user asks for their brief |
| `current_time` | ISO timestamp for time-relative responses |
| `user_name` | Owner's display name |
| `recent_memory` | Last 5 session memory summaries from `carson_memory` table |

All speech-bound text is sanitized with `sanitizeForCarsonSpeech()` before injection. This replaces all Ra7etBal Latin variants with `راحة بال` so ElevenLabs TTS pronounces the brand correctly.

### Client Tools

| Tool | What it does |
|---|---|
| `send_delegation` | Creates delegation task + sends WhatsApp message to named person |
| `send_followup` | Creates followup task + sends WhatsApp follow-up to named person |
| `create_reminder` | Creates reminder task + schedules QStash push notification |

Tools have 30-second per-person cooldowns to prevent duplicates.

### Memory (V3)

At session end (`onDisconnect`):
1. Full conversation transcript accumulated via `onMessage` callback
2. `summarizeConversation(transcript)` calls `/api/anthropic` with Haiku
3. Prompt extracts 3–7 bullets: preferences, habits, corrections, open loops, people, ideas
4. Category labels added: `Preference:` / `Habit:` / `Person:` / `Correction:` / `Open loop:` / `Idea:` / `Product feedback:`
5. Merged with action log (tool calls that succeeded)
6. Saved to `carson_memory` table via `saveSessionMemory()`
7. Loaded into next session as `recent_memory` dynamic variable

Minimum 1 user turn required to trigger summarization.

### Daily Brief (V1)

`buildCarsonSpokenBrief(brief, displayName, now)` in `src/lib/daily-brief.ts`:

Generates a ready-to-speak paragraph covering:
1. **Needs Attention** — overdue reminders + non-reminder attention items
2. **Waiting on Others** — unconfirmed delegated tasks (names the person)
3. **Completed Today** — delegated: "Grace confirmed: [task]" / personal: "You completed '[task]'"
4. **Today's Reminders** — pending reminders due today, not yet overdue

Time-of-day greeting: Good morning / afternoon / evening `[name]`.

---

## Delegation Flow (End-to-End)

```
1. Owner says/types "Ask Grace to call me"
2. Extraction rewrites to "Call Sana in [time]" (pronoun rewrite)
3. Task row saved: type=delegation, assigned_to="Grace", status=pending
4. Confirmation URL generated: /confirm?task=<id>
5. WhatsApp sent to Grace's number via Meta Cloud API
6. Grace opens /confirm → sees task description
7. Grace taps "Mark done"
8. POST /api/confirm-task → status=done, confirmed_at=now
9. Owner receives web push: "Grace confirmed: Call Sana in one minute"
10. Daily Brief next session: "Grace confirmed: Call Sana in one minute."
```

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `tasks` | All task types (reminders, delegations, followups, actions, etc.) |
| `messages` | Outgoing WhatsApp message records (paired with delegation tasks) |
| `people` | Household contacts with name, role, phone |
| `confirmations` | Audit log of confirmation events |
| `push_subscriptions` | Web push subscription records (endpoint, p256dh, auth) |
| `carson_memory` | Per-session memory summaries (LLM bullets + action log) |
| `profiles` | Owner display name |

All tables have RLS: `user_id = auth.uid()`. Confirmations and push delivery use the service role key server-side.

---

## Serverless API (`/api/*.js`)

| Endpoint | Purpose |
|---|---|
| `POST /api/anthropic` | Proxy to Anthropic API (extraction + memory summarization) |
| `POST /api/send-whatsapp-task` | Send WhatsApp template message via Meta Cloud API |
| `POST /api/confirm-task` | Mark task done + send owner push notification |
| `GET /api/get-confirm-task` | Load task for /confirm page (no auth required) |
| `POST /api/qstash-reminder` | Schedule QStash job for reminder push |
| `POST /api/qstash-reminder` (receiver) | Receive QStash delivery → send push |
| `POST /api/send-push-for-task` | Send push for a specific task |
| `POST /api/send-due-reminder-pushes` | Cron: send pushes for overdue reminders |
| `POST /api/transcribe` | Transcribe audio via Whisper (typed input fallback) |
| `GET /api/whatsapp-webhook` | Meta webhook verification |
| `POST /api/whatsapp-webhook` | Receive incoming WhatsApp messages |
| `GET /api/health` | Health check |

---

## Frontend Routes

| Route | Purpose |
|---|---|
| `/` | Home — brief state, typed input, Carson widget |
| `/review` | Review extracted items before saving |
| `/actions` | Active tasks dashboard (needs attention / waiting / later) |
| `/messages` | Sent messages (WhatsApp copy history) |
| `/people` | Manage household contacts |
| `/follow-ups` | Follow-up items view |
| `/history` | Archived tasks and messages |
| `/confirm` | Recipient-facing confirmation page (no auth) |
| `/auth` | Sign in / Create account |
| `/reset` | Password reset |
| `/debug` | Internal debug view |

---

## Key Files

```
src/
  lib/
    ai/
      extract-prompt.ts     LLM extraction prompt (8 item types, pronoun rules)
      extract.ts            Calls /api/anthropic, parses ExtractedItem[]
    carson-memory.ts        saveSessionMemory() / loadRecentMemory()
    carson-summarize.ts     summarizeConversation() — Haiku-based memory bullets
    daily-brief.ts          buildDailyBrief() + buildCarsonSpokenBrief()
    save.ts                 savePending() — writes tasks + messages to Supabase
    speech-sanitize.ts      sanitizeForCarsonSpeech() — Ra7etBal → راحة بال
    parse-voice-time.ts     Parses natural-language time phrases for reminders
    reminder-time.ts        isReminderOverdue() / formatReminderDue()
    whatsapp.ts             sendWhatsAppTask() client wrapper
    push-notifications.ts   Web push subscription management
    qstash-reminder.ts      scheduleReminderPush() — QStash job creation
  components/
    home/
      ElevenLabsAgentWidget.tsx  Carson voice UI + client tools + memory pipeline
  routes/
    Home.tsx                Main screen — builds brief state + spoken brief
    Review.tsx              Extraction review + save
  stores/
    tasks.ts                Zustand tasks store
    people.ts               Zustand people store
    profile.ts              Zustand profile store (displayName)
    extraction.ts           Zustand extraction store (run, items, status)
api/
  confirm-task.js           Marks done + fires owner push (awaited before response)
  send-whatsapp-task.js     Meta Cloud API delivery
```

---

## Constraints and Rules

- **One owner per account.** No multi-user. No sharing.
- **No hardcoded names.** Owner name comes from `profiles.display_name` at runtime.
- **Pronouns rewritten twice** for delegations: once in the LLM prompt (best effort), once in `save.ts` and `ElevenLabsAgentWidget.tsx` at write boundary (guaranteed).
- **Confirmation links need no auth.** `/confirm?task=<id>` uses service role server-side — no RLS required on the tasks table for this path.
- **Push is fire-and-await, not fire-and-forget.** Vercel terminates serverless functions after `res.json()` — push calls must be awaited before the response is sent.
- **QStash for reminders.** Not cron-based. Each reminder gets an exact-time delivery job. `qstash_message_id` is stored on the task for cancellation.
- **Speech sanitization is one-way.** `sanitizeForCarsonSpeech()` is only applied at the ElevenLabs injection boundary — never to stored data, WhatsApp text, or UI.
- **Memory is non-blocking.** All session memory work happens in a fire-and-catch async block after `onDisconnect`. UI is already idle. Failures are silent.

---

## Environment Variables

```
# Supabase
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

# ElevenLabs
VITE_ELEVENLABS_AGENT_ID

# Anthropic
ANTHROPIC_API_KEY

# Meta / WhatsApp
META_WHATSAPP_TOKEN
META_PHONE_NUMBER_ID
META_WEBHOOK_VERIFY_TOKEN
META_TEMPLATE_NAME

# Web Push
VAPID_PUBLIC_KEY
VITE_VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT

# Upstash QStash
QSTASH_TOKEN
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
VITE_APP_URL
```

---

## What Is Not Built Yet

- Multi-user / shared household accounts
- In-app notification center
- Recurring reminders
- Carson stuck-mic fix (investigated: `stopSession` sets idle before `endSession` resolves; needs `"disconnecting"` state)
- WhatsApp inbound parsing (webhook exists, handler is stub)
- Calendar integration
- Carson reading calendar as a dynamic variable
