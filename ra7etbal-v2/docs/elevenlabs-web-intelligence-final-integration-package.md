# ElevenLabs Web Intelligence Final Integration Package

Status: documentation only. Do not implement these steps until the manual ElevenLabs rollout is approved.

This package exposes the existing Web Intelligence endpoint to Carson through ElevenLabs. It does not add new intelligence, maps, shopping, lifestyle logic, UI, or app actions.

## Integration Goal

Prove the full ElevenLabs tool loop:

User asks a question that needs outside information -> Carson calls `research_web` -> Ra7etBal server calls the provider safely -> Carson gives a calm Chief of Staff answer.

The tool must remain read-only. Carson must never act automatically based on the result.

## 1. Exact ElevenLabs Tool Configuration

Tool name:

`research_web`

Tool type:

Server/API tool

HTTP method:

`POST`

URL:

`https://www.ra7etbal.com/api/web-research`

Headers:

```json
{
  "Content-Type": "application/json"
}
```

Authentication:

None in ElevenLabs.

Important: do not add Tavily keys, provider secrets, env vars, Supabase tokens, Google tokens, WhatsApp tokens, or user auth tokens to the ElevenLabs tool. The Ra7etBal server owns provider credentials.

Timeout:

Use the ElevenLabs default unless a timeout setting is required. If required, use 20 seconds.

Tool visibility:

Available to Carson only for external research. It is not a general action tool.

## 2. Exact JSON Schema

Use this input schema for the ElevenLabs tool.

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "query": {
      "type": "string",
      "description": "The external research question Carson needs answered. Do not include secrets or internal Ra7etBal state."
    },
    "maxFindings": {
      "type": "number",
      "description": "Optional number of findings to return. Use 3 by default for voice, 5 when comparison needs more context."
    },
    "region": {
      "type": "string",
      "description": "Optional country, city, or market hint when location affects the answer."
    },
    "language": {
      "type": "string",
      "description": "Optional language code. Use en unless the user asks otherwise."
    },
    "freshness": {
      "type": "string",
      "enum": ["any", "day", "week", "month"],
      "description": "Optional recency filter. Use only when freshness matters."
    }
  },
  "required": ["query"]
}
```

Default values Carson should infer when useful:

```json
{
  "maxFindings": 3,
  "language": "en",
  "freshness": "any"
}
```

Do not send optional fields when they are unknown or irrelevant.

## 3. Exact Request Body

Basic request:

```json
{
  "query": "best way to remove limescale from a kettle",
  "maxFindings": 3
}
```

Location-sensitive request:

```json
{
  "query": "same day flower delivery near Dubai Marina",
  "maxFindings": 3,
  "region": "AE",
  "language": "en",
  "freshness": "week"
}
```

Current official information request:

```json
{
  "query": "current UAE passport renewal requirements official source",
  "maxFindings": 3,
  "region": "AE",
  "language": "en",
  "freshness": "month"
}
```

## 4. Exact Response Mapping

Expected backend response:

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
  "risks": [],
  "suggestedNextSteps": ["string"],
  "metadata": {
    "provider": "string",
    "readOnly": true,
    "generatedAt": "string",
    "requiredEnvVars": ["string"]
  }
}
```

Map response fields this way:

- `summary`: primary answer candidate. Carson should use this to form the first sentence.
- `findings`: supporting facts. Use only the top 1 to 3 findings in voice.
- `sources`: source context. Do not read URLs aloud unless the user asks.
- `risks`: caution signals. Mention only if relevant to user safety or decision quality.
- `suggestedNextSteps`: optional next-step ideas. Use only if they reduce mental load.
- `metadata.readOnly`: confirms no app action happened.
- `metadata.provider`: internal only. Do not say provider name unless debugging outside user conversation.

If response is successful but weak:

- Give a cautious answer.
- Say confidence is limited only if it helps the user.
- Offer to narrow the search if location, budget, or timing would improve the answer.

Expected safe error response:

```json
{
  "ok": false,
  "code": "string",
  "error": "string"
}
```

Error mapping:

- `empty_query`: ask one short clarification question.
- `missing_provider`, `missing_api_key`, `provider_error`, or other errors: say Carson cannot verify current information right now.
- Never mention provider names, API keys, env vars, Vercel, serverless functions, or Tavily to the user.

## 5. Exact Carson Prompt Additions

Add this to Carson's ElevenLabs system prompt only when ready to enable the tool.

```text
You have a read-only tool named research_web for external web research.

Use research_web only when outside information reduces uncertainty for the user:
- current information
- comparing options
- finding services, places, products, or solutions
- recommendations that require outside information
- questions you cannot answer safely from Ra7etBal internal memory alone

Do not use research_web when:
- the answer is in Ra7etBal internal data
- the user asks about tasks, notes, reminders, delegations, calendar, or people inside Ra7etBal
- the user asks you to take an internal app action
- the user needs emotional support or simple conversation
- existing context is enough

Prefer action over research.
If the user needs something done, act using the appropriate existing Ra7etBal tool first.
Research only if the action depends on information you do not have.

Research should be invisible whenever possible.
If the user only needs an answer, give the answer.
Do not say "I searched the web", "I researched this", or "I found sources" unless freshness matters, confidence is low, the user asks for sources, or the topic is high risk.

After using research_web:
- summarize first
- give recommendation before raw information
- provide a maximum of 3 options by default
- keep voice responses concise
- do not read URLs aloud unless asked
- never act automatically from research results
- ask one short clarification question if location, budget, timing, or preferences are required
- sound like a Chief of Staff who used research in the background, not a search engine

For high-risk topics such as medical, legal, financial, travel, official requirements, safety, or regulated decisions, give a cautious summary and tell the user to verify with the official source before acting.
```

## 6. Exact Examples

### Example A: Household Answer

User:

"What is the best way to remove limescale from a kettle?"

Tool call:

```json
{
  "query": "best way to remove limescale from a kettle",
  "maxFindings": 3
}
```

Spoken response:

"Vinegar works well. Citric acid is usually cleaner because it leaves less smell. Boil it with water, let it sit, then rinse the kettle thoroughly."

### Example B: Prefer Action Over Research

User:

"Message Grace and ask her to order flowers."

Tool call:

None.

Spoken response:

Use the existing message/delegation capability. Do not research florists.

### Example C: Research Needed Before Decision

User:

"Find me a florist for same-day delivery."

Clarification if location is unknown:

"What area should I search in?"

Tool call after user gives location:

```json
{
  "query": "same day flower delivery near Dubai Marina",
  "maxFindings": 3,
  "region": "AE",
  "language": "en",
  "freshness": "week"
}
```

Spoken response:

"I would start with the option that can confirm delivery time and send a photo before dispatch. I found a few choices, but delivery window matters most here."

### Example D: Internal Data Should Not Research

User:

"What is on my to-do list?"

Tool call:

None.

Spoken response:

Use Ra7etBal's internal to-do capability.

### Example E: High-Risk Current Information

User:

"What are the current passport renewal requirements?"

Tool call:

```json
{
  "query": "current passport renewal requirements official source",
  "maxFindings": 3,
  "freshness": "month"
}
```

Spoken response:

"The requirements appear to depend on the issuing country and renewal location. I would verify on the official government site before acting. Tell me which passport, and I can narrow it."

### Example F: Tool Failure

Tool response:

```json
{
  "ok": false,
  "code": "provider_error",
  "error": "Web research provider failed."
}
```

Spoken response:

"I cannot verify current information right now. I can give a general answer, or we can try again in a moment."

## 7. Exact Testing Plan

Phase 1: Dashboard tool test only.

1. Create the tool in ElevenLabs with the schema above.
2. Use the dashboard test console.
3. Send:

```json
{
  "query": "best way to remove limescale from a kettle",
  "maxFindings": 3
}
```

Expected:

- HTTP 200.
- `ok: true`.
- Useful `summary`.
- At least one `finding`.
- At least one `source`.
- No API key or provider secret in response.

4. Send:

```json
{
  "query": ""
}
```

Expected:

- Safe error.
- `ok: false`.
- `code: empty_query`.
- No crash.
- No secret exposure.

Phase 2: Prompt-controlled voice test.

Test phrases that should use research:

1. "What is the best way to remove limescale from a kettle?"
2. "Compare vinegar and citric acid for cleaning a kettle."
3. "Find same-day flower delivery near Dubai Marina."
4. "What are the current UAE passport renewal requirements?"

Expected:

- Carson calls `research_web`.
- Carson summarizes first.
- Carson gives recommendation before raw detail.
- Carson gives no more than 3 options by default.
- Carson does not say "I searched the web" unless freshness, confidence, sources, or risk make it useful.
- Carson does not act automatically.

Test phrases that should not use research:

1. "What is on my to-do list?"
2. "Remind me to buy flowers tomorrow."
3. "Message Grace and ask her to order flowers."
4. "Ask Ghulam to bring the car."
5. "What is on my calendar today?"
6. "I'm overwhelmed."
7. "Thank you."

Expected:

- Carson does not call `research_web`.
- Carson uses the relevant existing Ra7etBal capability or responds conversationally.

Phase 3: Edge behavior test.

Ambiguous request:

"Find me a cleaner."

Expected:

- If location is unknown, Carson asks: "What area should I search in?"
- Carson does not call the tool until the needed context is available.

High-risk request:

"Is this medicine safe?"

Expected:

- Carson should be cautious.
- Carson should not provide medical certainty.
- Carson should recommend checking with a doctor/pharmacist or official source.

## 8. Rollout Plan

Step 1: Add tool in ElevenLabs dashboard.

- Name: `research_web`.
- Method: `POST`.
- URL: `https://www.ra7etbal.com/api/web-research`.
- Headers: `Content-Type: application/json`.
- Schema: use the schema above.
- No secrets in ElevenLabs.

Step 2: Test the raw tool in ElevenLabs dashboard.

- Kettle query should return `ok: true`.
- Empty query should return `ok: false`.
- Confirm no API keys or secrets appear.

Step 3: Add Carson prompt additions.

- Add only the prompt block in this document.
- Do not change existing tool descriptions.
- Do not remove existing Carson capabilities.

Step 4: Voice test with controlled phrases.

- Verify positive use cases.
- Verify anti-use cases.
- Verify action-over-research behavior.
- Verify invisible research behavior.

Step 5: Limited production use.

- Use for low-risk household and comparison questions first.
- Avoid high-risk domains until behavior is stable.
- Monitor whether Carson overuses research.

Step 6: Expand later.

- Maps, Shopping, and Lifestyle Intelligence should only be built after the full tool loop is proven stable.

## Rollback Plan

If Carson overuses research or responses become noisy:

1. Disable the `research_web` tool in ElevenLabs.
2. Remove or comment out the prompt additions.
3. Keep the backend endpoint deployed.
4. Re-test behavior without the tool.

No app deploy is required for dashboard-only rollback.
