# Owner telephone Stage 1 — inactive implementation

Owner authorized implementation on 2026-10-17. No provider configuration, purchase,
call, migration, merge or deployment is authorized by this artifact.

## Behavior

The existing authenticated periodic escalation sweep considers newly created,
open owner decisions linked to a pending task and a processed WhatsApp staff
blocker/clarification/permission request. Routine updates, no-response reminders,
unlinked messages, old backlog and closed tasks do not dial. At most one owner
call is active, one attempt per decision, two attempts per day, twenty per month,
and 180 seconds per call. Actual configured limits may be lower. Quiet hours,
cutover, destination prefixes and expiry of the provider review are mandatory.
Provider errors/timeouts consume reservations; an uncertain paid request is never
retried. Budget/CAS contention before dialing defers the decision. Allowances are
conservative USD reservations using an owner-reviewed all-in rate, not a guarantee
of carrier invoices; carrier/ElevenLabs account spending caps must be reviewed.

Only one canonical Boss record can supply the destination. The API never accepts
a destination number, task id, owner id or decision id from a model or caller.
No task details are sent in call initialization. The owner opens Notifications,
refreshes updates, explicitly agrees to transcription and reads the call-specific
code from their existing signed-in Supabase session. Three incorrect attempts
lock the call. Provider authentication and a separate secret per-call capability
are both required. No code, JWT, telephone number or capability is logged.

The dedicated server tool reads fresh context after authentication, proposes a
read-back, and records the latest confirmed interpretation in the existing owner
notification linked to the original task/decision. The provider's interpretation
is not an execution authorization. Review call response opens the EXISTING
owner decision page. Its existing authenticated approve/reject/custom instruction
flow remains the only execution path. Nothing is automatically approved, sent to
staff, completed, or ingested into memory. Missed/voicemail/expired calls keep the
original decision open. No inbound route or staff calling exists.

Local response content is redacted after retentionDays by the same periodic
worker, even when dialing is disabled or the provider review expires, provided
OWNER_TELEPHONE_RETENTION_ENABLED remains true. Keep that maintenance flag on
while receipts exist. Consent timestamps, proposed/confirmed text and call tokens
are removed; minimal decision/task identifiers and content-free outcome remain.
Existing account deletion guards and owner-notification deletion apply. Provider
retention/deletion remains separate; no complete-deletion promise is made.

## Configuration required before any separately approved test

No account credentials are available in this implementation environment.
Leave OWNER_TELEPHONE_ENABLED unset/false until setup and deployment are approved.
Use an isolated phone agent configuration with Carson's existing approved voice;
do not modify the live browser agent or activate Second Brain/parked architecture.

Server settings: OWNER_TELEPHONE_USER_ID (one pilot owner),
OWNER_TELEPHONE_RETENTION_ENABLED=true, OWNER_TELEPHONE_SECRET (32+ random chars),
OWNER_TELEPHONE_PROVIDER_SECRET (different 32+ random chars), ELEVENLABS_API_KEY,
ELEVENLABS_PHONE_AGENT_ID and ELEVENLABS_PHONE_NUMBER_ID (Twilio-imported,
outbound-capable number, with inbound assignment disabled). Keep keys server-only.

OWNER_TELEPHONE_POLICY is JSON containing: cutoverAt and reviewExpiresAt (ISO,
review window at most 31 days), timeZone (IANA), startHour/endHour (local allowed
calling window), allowedPrefixes (explicit reviewed international prefixes),
dailyLimit (1–2), monthlyLimit (1–20), maxCallSeconds (60–180), maxPerMinuteUsd
(reviewed all-in carrier/platform/model rate ceiling), monthlyBudgetUsd (up to
100), retentionDays (1–30), consentVersion, callbackOrigin (the approved HTTPS
staging or production origin; never mix environments), privacyAndInternationalReviewed=true,
reviewedAgentSha256 and reviewedToolSha256. The last two are computed by
agentFingerprint(agentReadback) and toolFingerprint(toolReadback.tool_config)
exported from api/_owner-telephone.js, after review, not guessed from templates.
Verify actual destination rates, local number regulations, provider spending
caps, processor agreements, recording/transcription consent, local/provider
retention and deletion, and the owner enrollment before setting the review flag.
Existing AI-consent/legal release gates are not closed by this implementation.

## Dedicated ElevenLabs agent / server tool contract

Use the EXACT PHONE_FIRST_MESSAGE and PHONE_PROMPT exports from
api/_owner-telephone.js (source-controlled configuration text). Set conversation
max_duration_seconds equal to policy.maxCallSeconds; privacy.record_voice=false
and privacy.retention_days equal to policy.retentionDays, with delete_audio=true
and delete_transcript_and_pii=true. No workflow, MCP,
knowledge base, browser/client tools, transfers or other operational tools.
Only built_in_tools.end_call and one prompt.tool_ids entry are permitted.
Do not attach this phone configuration to an inbound number.

Create one webhook tool named owner_phone, pre_tool_speech=off, immediate
execution, method POST, URL
{callbackOrigin}/api/task-confirm?ownerTelephone=tool, JSON content.
Use a Secret-type Authorization header containing the complete Bearer value for
OWNER_TELEPHONE_PROVIDER_SECRET. Set x-carson-phone-token from dynamic header
variable secret__owner_phone_token (never LLM generated). Configure receiptId
as a required string sourced from dynamic_variable owner_phone_receipt_id.
Configure action as a required LLM string (authenticate/propose/confirm/finish),
and optional LLM properties code (string; preserve six digits), answer (string,
up to 1000 chars), proposalId (string from propose response), confirmed (boolean).
The server enforces the transition sequence. Verify these header mappings in the
provider read-back before calculating reviewedToolSha256. Only code/action and
answer fields are model-generated; ownership and credentials are not.

The deployed task-confirm dispatcher multiplexes owner verification via
POST ?ownerTelephone=owner (existing owner Bearer JWT; receiptId, consent) and
provider tools via POST ?ownerTelephone=tool (provider and per-call headers).
No new Vercel function route or schema is introduced. Existing scheduler auth
and testMode guards stay in front of all automatic dialing. Per-task triggers
cannot dial. Mocked provider tests do not prove live tool or audio behavior.

Official interfaces checked on 2026-10-17:
- https://elevenlabs.io/docs/api-reference/integrations/twilio/outbound-call
- https://elevenlabs.io/docs/api-reference/agents/get
- https://elevenlabs.io/docs/api-reference/tools/create
- https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables

A separately approved real end-to-end call is required to prove ringing, owner
verification, speech/read-back, server-tool bindings and saved response. Review
and authorize any consequential action through the unchanged decision page.

## Review and account readiness — 2026-10-17

Manual security/compatibility review found two missing fail-closed checks: a
fingerprinted agent could still include a knowledge base, and the two required
secrets could be identical. Both are now rejected with regression coverage.
The automated security scanner was unavailable; this is a manual review plus
mocked tests, not a provider or live-call certification. Agent workflows remain
conservatively rejected, including empty workflow objects: inspect real provider
read-back before changing that guard. Server webhook tools must be configured
separately; the browser agent's client tools are not telephone server tools.

Read-only Vercel environment-name inspection confirms existing ElevenLabs API key,
Twilio account SID/auth token/from-number settings. Values were not decrypted,
used or changed. No OWNER_TELEPHONE settings or dedicated ElevenLabs phone agent /
imported phone-number settings were present. Existing account balances, number
voice capability, verified destinations, geographic permissions, API scopes and
number ownership remain unverified. Reuse these accounts and existing suitable
number first; no new account, key or number was created. The dedicated agent/tool
contract above is prepared, but cannot be installed or read back without approved
provider access and any required new telephone secrets. Do not change the live
browser agent or PR #458 settings.

Provider prerequisites: import an existing outbound-capable Twilio number into
ElevenLabs using the existing account credentials through a secure administrator
interface. Confirm this does not overwrite another application's webhook. Keep
inbound agent assignment disabled. Check trial-account verified-destination
restrictions, sufficient existing balance, outbound geographic permissions and
carrier restrictions for the exact destination prefix. No claim of account-level
readiness is made from environment variable names alone.

Official rate examples checked 2026-10-17 (USD; not an account quote): ElevenLabs
public Agents pricing lists $0.08 per additional minute; actual existing plan /
renewal allowance and model charges require account verification. Twilio Turkey
lists $0.2875/min mobile and $0.0701/min fixed line. Turkey is an illustration,
not a verified owner destination; Istanbul timezone does not prove phone country.
For a three-minute Turkey-mobile call, the platform + carrier subtotal is
3 * (0.08 + 0.2875) = $1.1025; 20 / 100 / 500 calls yield $22.05 / $110.25 /
$551.25, excluding LLM, number rental, taxes, rounding, possible media-stream
fees, burst pricing and any account-specific rates. Included ElevenLabs minutes
may reduce incremental charges; voicemail may consume connected time. The pilot
hard cap remains 20 attempts/month, so 100 and 500 are comparison scenarios only.
Do not use this subtotal as the all-in policy ceiling. Review actual prefix and
model costs and account spending controls before enabling the policy.

Twilio's Turkey guidelines prohibit Turkish or anonymous caller ID on calls to
Turkey. Verify the selected originating number complies. Other destinations need
their own official restrictions; enable only reviewed prefixes. No recording is
requested, but transcription and provider processing still occur, including
initial greeting before app consent. Owner enrollment must cover that processing
before activation; the app code consent alone cannot retroactively authorize it.
Confirm applicable jurisdiction, processor/data-transfer terms, provider log /
transcript retention, deletion capabilities and consent withdrawal before setting
privacyAndInternationalReviewed. Provider default retention must not be trusted.
The existing unresolved AI-consent/legal release gates remain unresolved.

References:
- https://elevenlabs.io/pricing/agents
- https://www.twilio.com/en-us/voice/pricing/tr
- https://www.twilio.com/en-us/guidelines/tr/voice
- https://www.twilio.com/docs/voice/api/dialing-permissions
- https://www.twilio.com/docs/voice/twiml/record
- https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration

Publishing safety: exact-branch git.deploymentEnabled=false is included in the
repository root and both existing Vercel config roots. It disables automatic
Vercel deployment of feat/owner-telephone-stage1 only; main and PR #458 are
unchanged. No global project setting is modified. Deployment, activation and one
controlled paid end-to-end test still require separate owner approval.
