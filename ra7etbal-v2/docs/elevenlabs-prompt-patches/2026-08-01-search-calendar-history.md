# ElevenLabs Prompt Patch — search_calendar_history
**Date:** 2026-08-01
**Feature:** Historical Calendar Lookup
**PR:** #145

---

## What to do

Two insertions into the live ElevenLabs dashboard prompt. Open the Carson agent → System Prompt tab, then make both changes below.

---

## Insertion 1 — TOOLS section

Find this block (end of TOOLS section):

```
delete_calendar_event:
Use when the user asks to remove an existing calendar event.
```

Immediately after it, add:

```
search_calendar_history:
Use when the user asks about past calendar events — "when did I last meet X", "what happened on [date]", "find my dentist appointment", "last time I saw Grace". Always provide both start_date and end_date. For vague "last time" or "when was the last" queries, default to the previous 12 months (today minus 365 days to today). Read the result naturally. Do not say event IDs. If no events are found, say so plainly.
```

---

## Insertion 2 — CALENDAR HISTORY section

Find this block (end of CALENDAR SOURCE OF TRUTH section):

```
CALENDAR SOURCE OF TRUTH
Google Calendar data returned by get_calendar_events is the source of truth for existing events.
If the user states a time or date that conflicts with the calendar:
State what the calendar shows.
Offer to move it.
Correct:
"I'm seeing that as 4 PM on the calendar. Do you want me to move it to 5?"
Do not repeat the user's incorrect time as fact.
```

Immediately after it, add:

```
CALENDAR HISTORY
When the user asks about a past calendar event — a previous meeting, appointment, or event — call search_calendar_history.
Do not use get_calendar_events for historical queries. get_calendar_events is for future events only.
Provide start_date and end_date in YYYY-MM-DD format.
For vague queries like "last time" or "when did I last", use the previous 12 months as the search window.
Include a query keyword when the user names a person, place, or event type.
If the result contains matching events, summarize them naturally: title, date, and relevant detail.
If no events match, say:
"I couldn't find a matching event in that period."
If Google Calendar needs reconnecting, say so.
Do not expose date ranges, result counts, or pagination details unless asked.
```

---

## Validation

After pasting, start a voice session and say:
> "When was the last time I had a dentist appointment?"

Carson should silently call `search_calendar_history` and respond with the matching event or say it couldn't find one. It must NOT call `get_calendar_events` for this query.

---

## Rollback

Remove the `search_calendar_history:` entry from the TOOLS section and the entire CALENDAR HISTORY section. The client tool registration in the widget code does not need to be reverted — it will simply be an unused registered handler until the prompt is restored.
