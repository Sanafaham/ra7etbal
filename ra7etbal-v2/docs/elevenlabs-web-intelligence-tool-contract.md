# ElevenLabs Web Intelligence Tool Contract

Status: documentation only. Do not connect this tool until the ElevenLabs dashboard and Carson prompt are updated intentionally.

## 1. Tool Name

`research_web`

## 2. Purpose

Give Carson a read-only way to answer questions that need current external information, comparison, or web research outside Ra7etBal internal memory.

The tool is for research only. It must not create tasks, reminders, notes, delegations, calendar events, messages, or any other app-side action.

## 3. Endpoint

`https://www.ra7etbal.com/api/web-research`

## 4. HTTP Method

`POST`

## 5. Request Schema

The ElevenLabs tool should send only the research query and optional non-secret search options.

```json
{
  "query": "string",
  "maxFindings": "number | optional",
  "region": "string | optional",
  "language": "string | optional",
  "freshness": "\"any\" | \"day\" | \"week\" | \"month\" | optional"
}
```

Required:

- `query`: the external research question Carson needs answered.

Optional:

- `maxFindings`: preferred number of findings. Use `3` to `5` for voice.
- `region`: country or market hint when location matters.
- `language`: preferred language code, such as `en`.
- `freshness`: use `day`, `week`, or `month` only when recency matters.

Never send:

- Tavily API key
- provider secrets
- internal env vars
- Supabase tokens
- Google tokens
- WhatsApp tokens
- user auth tokens

## 6. Response Schema

Expected success response:

```json
{
  "ok": true,
  "summary": "string",
  "findings": [
    {
      "title": "string",
      "snippet": "string",
      "url": "string | null",
      "sourceId": "string | null",
      "publishedAt": "string | null",
      "confidence": "number | null"
    }
  ],
  "sources": [
    {
      "id": "string",
      "title": "string",
      "url": "string",
      "provider": "string"
    }
  ],
  "risks": [
    {
      "severity": "\"low\" | \"medium\" | \"high\"",
      "message": "string",
      "sourceId": "string | null"
    }
  ],
  "suggestedNextSteps": ["string"],
  "metadata": {
    "provider": "string",
    "readOnly": true,
    "generatedAt": "string",
    "requiredEnvVars": ["string"]
  }
}
```

Expected safe error response:

```json
{
  "ok": false,
  "code": "string",
  "error": "string"
}
```

## 7. When Carson Should Use It

Use `research_web` when:

- The user asks for current information.
- The user asks to compare options.
- The user asks to find services, places, products, or solutions.
- The user asks for recommendations requiring outside information.
- Carson cannot answer safely from internal memory alone.

Examples:

- "Find a good plumber near me."
- "What is the best way to remove limescale from a kettle?"
- "Compare two nearby flower delivery options."
- "Is this product still recommended?"
- "What are current visa renewal requirements?"

## 8. When Carson Should Not Use It

Do not use `research_web` when:

- The answer comes from Ra7etBal internal data.
- The user asks about tasks, notes, reminders, delegations, calendar, or people already inside Ra7etBal.
- The user asks Carson to take an internal app action.
- The user needs emotional support or simple conversation.
- Existing context is enough.

Examples that should not call this tool:

- "What is on my to-do list?"
- "Remind me to buy flowers tomorrow."
- "Ask Grace to buy flowers."
- "What is on my calendar today?"
- "Who am I waiting on?"
- "I'm overwhelmed."
- "Thank you."

## 9. How Carson Should Respond After Using It

Carson should give a concise, calm answer that helps the user decide what to do next.

Response structure:

1. Direct answer in one sentence.
2. One to three useful details.
3. Source mention if helpful.
4. Clear next step if there is one.

Carson should not read long lists of sources aloud. Mention sources naturally, such as "I found this across cleaning guides and repair forums."

Additional behavior policy rules:

11. Research should be invisible whenever possible.

If the user only needs an answer, Carson should give the answer.

Do not announce:

- "I searched the web"
- "I researched this"
- "I found sources"

Only mention research when:

- Freshness matters.
- Confidence is low.
- The user asks for sources.
- The topic is high risk.

Example bad:

"According to my web research, vinegar works well."

Example good:

"Vinegar works well. Citric acid usually leaves less smell."

12. Carson should prefer action over research.

If the user needs something done, Carson should act first.

Research only if the action depends on information Carson does not have.

Example:

User: "Find me a florist."

Carson should research.

User: "Message Grace and ask her to order flowers."

Carson should not research. Carson should send the message.

## 10. Failure Behavior

If the tool returns `ok: false`, Carson should not claim the answer is known.

Use calm fallback language:

- "I could not reach web research right now."
- "I can answer from general knowledge, but I cannot verify current sources at the moment."
- "I could not find a reliable current result for that."

For empty or unclear queries, ask one short clarification question.

For provider errors, do not mention Tavily, API keys, env vars, serverless functions, or internal implementation details.

## 11. Voice Behavior

Voice responses should be short and useful.

Rules:

- Do not narrate the tool call.
- Do not say "searching the web" unless the user needs that context.
- Do not read URLs aloud unless explicitly asked.
- Default response should be answer first, sources only if useful.
- Carson should not make the tool visible unless it helps the user trust the answer.
- Carson should never sound like a search engine.
- Carson should sound like a Chief of Staff who used research in the background.
- Keep the answer under about 20 seconds for routine household questions.
- For comparisons, give the top two or three options only.
- If the result affects safety, health, money, travel, legal, or official requirements, say that the user should verify with the official source before acting.

## 12. Safety Rules

- Read-only only.
- No automatic actions.
- No automatic WhatsApp.
- No automatic reminders.
- No automatic calendar changes.
- No writes to Supabase.
- No internal app state changes.
- Never expose provider secrets.
- Never include API keys in requests, responses, logs, or spoken output.
- Prefer official or high-confidence sources for current, regulated, medical, legal, financial, or travel-related information.
- Do not use web results to override Ra7etBal internal task/calendar/person state.

## 13. Example Tool Calls

Basic household research:

```json
{
  "query": "best way to remove limescale from a kettle",
  "maxFindings": 5
}
```

Current local service search:

```json
{
  "query": "same day flower delivery near Dubai Marina",
  "maxFindings": 3,
  "region": "AE",
  "language": "en",
  "freshness": "week"
}
```

Comparison:

```json
{
  "query": "compare vinegar and citric acid for descaling electric kettle",
  "maxFindings": 4
}
```

Current information:

```json
{
  "query": "current UAE passport renewal requirements official source",
  "maxFindings": 3,
  "region": "AE",
  "freshness": "month"
}
```

## 14. Example Spoken Responses

Kettle limescale:

"The simplest option is to boil a mix of water and white vinegar or lemon juice, let it sit, then rinse the kettle thoroughly. Citric acid is also commonly recommended and usually smells less than vinegar."

Comparing options:

"Citric acid is usually the cleaner option for kettles because it works well and leaves less smell. Vinegar also works, but you may need extra rinsing."

Nearby service:

"I found a few same-day flower delivery options. I would compare delivery window, recent reviews, and whether they can confirm the arrangement before sending."

Current official information:

"I found current guidance, but because this is an official requirement, I would verify it on the government site before acting."

Tool failure:

"I could not reach web research right now. I can give a general answer, but I cannot verify current sources at the moment."
