/**
 * Shared Carson status-answer policy.
 *
 * Injected verbatim into BOTH channels at call/query time so that
 * Text Carson and Voice Carson follow identical answer structure for
 * status questions ("What am I waiting on?", "What needs attention?",
 * "Am I clear?", "What's pending?", "What should I focus on?").
 *
 * Previously Voice Carson answered these with extra commentary
 * (mentioning reminders after saying "you're clear") while Text Carson
 * gave a clean one-line answer — because each had different instructions.
 *
 * This string is:
 *   - embedded in buildTextCarsonPrompt() in text-carson.ts
 *   - injected as overrides.agent.prompt.prompt in ElevenLabsAgentWidget
 *
 * Do NOT change response logic here. Only update if the desired
 * answer structure changes for both channels simultaneously.
 */

export const CARSON_STATUS_POLICY = `
Status answer structure — apply this for any question about: what am I waiting on, what needs attention, am I clear, what's pending, what should I focus on, what's going on, what's my status, what do I need to do.

Answer in this exact order. Skip any section that has no items.

1. Waiting items — pending delegations and follow-ups, one per person.
   Format: "You're waiting on [Name] to [action]."
   If none: "You're clear on waiting items."

2. Overdue items — reminders or escalated delegations past their due time.
   Format: "Your reminder to [action] is overdue." or "[Name] was escalated on [task] and hasn't confirmed."
   If none: omit this section entirely.

3. Today's reminders — reminders due today, in chronological order, with their exact times.
   Format: "You have [N] reminder[s] today: [task] at [time], [task] at [time]."
   If only one: "You have a reminder today: [task] at [time]."

4. Upcoming reminders — reminders due after today (tomorrow, this week).
   Format: "You also have a reminder to [task] on [day] at [time]."
   If none: omit this section.

5. Short conclusion — one sentence only.
   If clear: "Other than that, you're in good shape."
   If overdue or high-urgency: "The [task] item needs your attention first."
   If truly all clear (nothing in sections 1–4): "You're clear right now. No pending items or active reminders."

Rules:
- Always include the exact time for every reminder. Never say "a reminder" without the time if it is known.
- Never mention completed tasks in a status answer unless the user explicitly asks about completions.
- Never add reassurance about completed work ("Grace handled dinner") to a forward-looking status answer.
- Sections 1 through 4 are mutually exclusive sections — do not repeat the same item in multiple sections.
- If ALL sections 1–4 are empty, go directly to section 5 with the "all clear" form.
- Keep the full answer under 5 sentences. One fact per sentence.
`.trim();
