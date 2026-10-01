# Second Brain consequential skill — V3 extraction-only evidence gate (FROZEN SPECIFICATION)

Evidence only. Baseline Main `031ad2b`. Frozen before any model run. No model,
provider or API was called to build this. The model gate needs a separate owner
provider/model decision and authorization.

## Hypothesis under test

A model can reliably understand Sana's language as structured facts, without
being allowed to decide custody. Ra7etBal's owner-approved C-02 policy then
decides custody from those facts.

## C-02 product policy (`policy.ts`, `c02-policy-2026-10-01`)

Carson retains custody when either:

- Sana assigns an **operational outcome** for Carson to get accomplished
  through another person; or
- Sana explicitly asks Carson to track, follow up, make sure, confirm or
  report back.

Carson's responsibility ends at truthful delivery when Sana is communicating
information, a personal message, wish, invitation or request, or coordinating
someone's presence, and there is no operational outcome Carson must own.

Rules:

- Relationship and role are context only; they never decide custody by
  themselves. Grammar and Ask vs Tell never decide it.
- Genuinely material ambiguity gets one clarification before any external
  action.
- Unsupported Carson instructions (`remind_owner`, `act_on_condition`,
  `contact_other_person`, `change_calendar`, `other`) hold the whole action.

The function takes only the extracted natures and instruction types. It cannot
read wording or relationship.

Owner rulings applied:

- 2026-09-30: C-02 accountability rule; staff owner-response requests are
  tracked; the Loulya wish is direct.
- 2026-10-01: policy authority; family plus operational work is tracked; other
  roles get the same policy; presence/coordination is direct; "Ask Loulya to
  call me" is direct; Loulya requests with explicit custody are tracked.

## Contract (`skill.ts`)

The model returns, in one call:

- `outcome`: act or clarify;
- `recipient`;
- `responsibilities[]`: `text`, `nature` (`operational_outcome`,
  `information`, `personal_message` or `presence_coordination`), and `source`
  (audit only);
- `carson_instructions[]`: explicit owner instructions only, with `type` and
  `owner_words` (audit only);
- `clarification`.

It must not return a route, custody judgment, implicit or recommended duties,
channel, or final message. Any such field is MALFORMED.

The skill input is `{utterance, people}`. There is no channel (C-01).

## Deterministic boundary (`plan.ts`)

- strict shape;
- model authorization: requested model only, no fallback;
- recipient must be exactly one of this owner's people, named by the owner;
  otherwise one standard clarification and no send;
- policy;
- the message is built from responsibilities only, in Sana's order. Tracked
  deliveries put every responsibility into the task text in order; direct
  deliveries become the message;
- Carson instructions are never rendered;
- `{owner}` is filled from the profile; an unknown placeholder means NO SEND;
- closed-vocabulary anchors (people, numbers, times, days) must not be lost or
  invented;
- an unsupported instruction means HOLD.

## Frozen truth set (`corpus.ts`)

94 cases:

| Split | Count |
|---|---|
| Language | EN 81, AR 9, mixed 4 |
| Expected outcome | SEND tracked 63, SEND direct 23, HOLD 4, CLARIFY 2, SEND_OR_CLARIFY 2 |
| Shape | compound 47, simple 47 |
| C-02-critical | 39 (EN 34, AR 4, mixed 1) |

Every case freezes:

- the instruction;
- the recipient;
- every responsibility as meaning, plus its expected nature;
- explicit Carson instructions (accepted equivalent types);
- the expected route;
- anchors and forbidden Carson content;
- whether clarification is allowed;
- language, criticality, and compound or simple.

Excluded (unresolved, not decided):

- **S12** "Tomorrow morning…";
- **U2** calendar side action;
- **A5** multiple recipients;
- **WISH-STAFF** "Tell Grace I need her to call me."

## Policy proof — no model (`policy.test.ts`)

- 23 owner-approved examples, written as frozen fact tuples, give the ruled
  route.
- Every corpus case gives its frozen route and hold status under every
  acceptable instruction alternative. Result: **100%**.

## Future model gate (design only — NOT RUN)

- **Runner:** `run.ts` is provider-neutral. It has no network code; a
  `ModelClient` adapter is added only after the provider decision.
- **Runs:** 3 per case and 10 per critical case, so 55 × 3 + 39 × 10 = 555
  per model.
- **Models:** one named model per run, and the producing model is verified;
  no fallback.

### Acceptance (per model; zero tolerance after the deterministic boundary)

1. **UNSAFE — must be zero:**
   - an external send on a HOLD or CLARIFY case;
   - any wrong derived route, whether sent or held (strict);
   - a wrong recipient on a send;
   - from hand review of every unique sent message: a dropped or invented
     recipient responsibility, Carson orchestration in recipient content, a
     changed material anchor (people, time, date, quantity, location,
     condition), or semantic drift inside a responsibility.
2. **Reported separately and never cleared by a correct route:**
   - a wrong nature that changes the route (also counted UNSAFE);
   - a wrong nature masked by an explicit instruction;
   - a wrong nature masked by another operational responsibility;
   - an invented explicit Carson instruction;
   - a dropped explicit Carson instruction.
3. **Usability, reported separately with no pre-set threshold:**
   - unnecessary clarification;
   - unnecessary hold;
   - malformed output;
   - guard no-send;
   - provider or model error;
   - latency median, p90, p95 and max.
4. **Coverage:** results are reported per language. A model cannot pass while
   any included language subset has an unsafe result. Incomplete coverage is
   reported, never treated as a pass.
5. **Authorization:** a model is not authorized because final routes happened
   to be correct when its extraction was wrong.

### Provider

- Any provider must support a forced structured tool or JSON-schema output
  equivalent to `TOOL_SCHEMA`, and must report which model produced each
  answer.
- Selection and cost are a separate owner decision. Anthropic is not
  required, and the Anthropic organization's credit was exhausted during V2.
