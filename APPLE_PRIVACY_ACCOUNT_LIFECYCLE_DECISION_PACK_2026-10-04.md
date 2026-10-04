# Carson / Ra7etBal — 33A / 33B Apple Privacy and Account-Lifecycle Decision Pack

Date: 2026-10-04
Authority: canonical product decisions, specification, and local documentation only
Implementation authorization: none

Owner review recorded: 2026-10-04

## A. Executive decisions and remaining approvals

### 1. Native iOS account-access model

**APPROVED PRODUCT DIRECTION — `IOS_ACCESS_MODEL = INVITE_ONLY_SIGN_IN`**

The first intended native iOS release will be **invite-only / sign-in-only**. Preserve the existing approved-account model, server-side signup control, tenant isolation, and RLS. Give App Review a dedicated reviewer tenant rather than opening public signup.

Public or in-app signup is not authorized. A later change would require a new owner decision and a fresh launch, abuse, onboarding, support, deletion, privacy, and App Review assessment.

Legal review: not normally required for choosing the access model, but the resulting onboarding, territorial availability, age audience, privacy notice, and terms require policy/legal review.

### 2. Account-deletion initiation and irreversibility

**APPROVED PRODUCT DIRECTION — IRREVERSIBLE AFTER CONFIRMED SLICE A ENTRY**

Before final confirmation, the user may leave or cancel the interaction. Once the confirmed request is accepted and the Slice A freeze begins, deletion is irreversible from the user's perspective. Recovery handles failures; it does not resurrect deleted data or silently unfreeze partially deleted state.

The future UI remains **FIX BEFORE RELEASE**. No implementation is authorized here.

Legal review: required for final retention exceptions and public wording, not for the basic secure initiation pattern.

### 3. Deletion timeframe and current 30-day promise

**LEGAL/POLICY DECISION REQUIRED**

Owner direction is approved: the unsupported categorical 30-day completion guarantee must not remain as a release claim unless legal and operational evidence supports it. Final wording, any time guarantee, and retention periods remain blocked for legal/policy review.

Alternative: retain a 30-day commitment only after every downstream stage, provider dependency, exception, operational SLA, and escalation path can support it with evidence.

### 4. Retention exceptions

**LEGAL/POLICY DECISION REQUIRED**

Recommended default: deletion is the presumption. Any exception must name its purpose, authority, minimized fields, access boundary, duration or review trigger, and terminal deletion/anonymization action. No indefinite generic “security” retention.

### 5. Third-party AI consent

**APPROVED PRODUCT DIRECTION; IMPLEMENTATION FIX BEFORE RELEASE; LEGAL/POLICY REVIEW STILL REQUIRED**

Ra7etBal will use explicit, understandable, versioned consent before applicable personal data is transferred to third-party AI providers. Consent covers the relevant purpose and data categories, is limited rather than blanket authority, supports withdrawal, stays equivalent across voice and text, and renews after material processor/data-use changes. The detailed contract in Section G is approved product direction.

Exact legal wording, lawful basis, retention of consent evidence, provider representations, and territory/age-specific requirements remain open.

### 6. Notification lock-screen privacy

**APPROVED PRODUCT DIRECTION; IMPLEMENTATION FIX BEFORE RELEASE**

Generic notifications with no task text, names, household details, staff details, calendar details, message content, delegation instructions, or other personal content are the approved default. A later explicit user-controlled setting may enable richer previews only if separately approved.

Legal review: review the disclosure and default, but this is primarily a privacy/product choice.

### 7. App Review access

**APPROVED PRODUCT DIRECTION; IMPLEMENTATION FIX BEFORE RELEASE**

A dedicated, isolated reviewer-access mechanism/account will preserve ordinary authorization, RLS, tenant isolation and invite-only behavior. It will use durable credentials, synthetic seeded data, safe provider test routes, and no access to real people or real-user data.

Alternative: built-in demo mode, but only if Apple accepts it and it truthfully exercises the full reviewable product. This adds implementation and divergence risk.

## B. Account access model

### Approved contract: invite-only / sign-in-only

- The native app accepts credentials only for accounts already approved through the existing invite process.
- The native app does not display or expose account-creation controls.
- Server-side public signup remains disabled/gated; hiding native UI alone is insufficient.
- App Review receives a dedicated approved account and tenant. Reviewer access is not a public-signup exception or authorization bypass.
- Password recovery, session expiry, logout, device change, and account deletion remain available to approved accounts.
- Email/password remains the primary account system. On present evidence, this does not require Sign in with Apple under App Review Guideline 4.8.
- Adding Google, Facebook, or another third-party/social primary login requires a fresh 4.8 assessment.

### Consequences of allowing in-app account creation

- Public signup, abuse controls, rate limiting, verification, onboarding, support, and eligibility become release scope.
- Apple in-app account-deletion initiation is unambiguously mandatory.
- Privacy notice/consent must be presented before relevant processing begins.
- Age-audience, territory, terms, retention, and invitation governance must be re-decided.
- Tenant isolation, RLS, approvals, and Carson consequential-action boundaries may not be weakened.

### Recorded owner decision

1. `IOS_ACCESS_MODEL = INVITE_ONLY_SIGN_IN`.
2. Public signup, Auth changes and social login are not authorized.
3. App Review will use a dedicated reviewer-access mechanism/account.
4. Final native/client enforcement remains **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED**.

No Auth or signup change is authorized by this pack.

## C. Account-deletion product contract

### Product contract decidable now

1. **Location and language**
   - Settings > Account contains a clearly named **Delete account** action.
   - **Clear History** remains separate and continues to explain that People and the account remain.
   - Delete Account explains that it affects the account, Carson history/memory, operational data, media, connected access, and scheduled work, subject to disclosed approved exceptions.

2. **Authentication and identity**
   - The request requires an authenticated owner session.
   - The server derives the target identity; the client never supplies a victim user ID.
   - A stale/insufficiently recent session triggers proportionate reauthentication.

3. **Confirmation**
   - Show a concise consequence summary and one deliberate destructive confirmation.
   - Do not use manipulative friction, support-email gates, or ambiguous labels.
   - The final confirmation occurs before the Slice A request/freeze begins.

4. **Lifecycle shown to the user**
   - `READY_TO_REQUEST`: explanation and confirmation available.
   - `REQUESTED / FREEZING`: request accepted; no completion claim.
   - `IN_PROGRESS`: required internal and external stages are running.
   - `PARTIAL_OR_BLOCKED`: at least one required stage is unresolved; the account is not represented as deleted.
   - `FAILED_RETRYING`: safe retry is occurring; do not expose raw technical errors.
   - `REQUIRES_SUPPORT`: automatic recovery is exhausted or unsafe.
   - `COMPLETED`: shown only when the approved terminal evidence contract is satisfied.

5. **Irreversibility — approved**
   - Before final confirmation, the user may cancel or leave the interaction without creating a request.
   - After final confirmation and successful request acceptance, deletion cannot be cancelled by the user.
   - Slice A freezes consequential execution immediately. “Undo” must never silently unfreeze partially deleted state.
   - No product behavior promises restoration or resurrects deleted data.

6. **Truthfulness**
   - “Request received,” “deletion in progress,” “partially completed,” and “deleted” are distinct.
   - Provider request submission is not provider deletion.
   - Provider acceptance is not proof of completion unless the provider contract establishes that meaning.
   - A timeout or unknown result remains unresolved until reconciled.

7. **Operational effects after acceptance**
   - New Carson consequential actions stop.
   - Pending confirmations and approvals cannot execute.
   - Tasks, reminders, routines, automations, delegation follow-ups, escalations, WhatsApp sends, and push sends are cancelled where possible and otherwise fail closed.
   - Late callbacks cannot recreate tenant data or resume work.
   - Other devices/sessions lose authority according to the final Auth/session stage.

8. **Required deletion domains**
   - Carson typed history, voice references, notes, todos, pending operations, facts, summaries, persistent instructions, derived memory, and any vector/semantic representation.
   - Tasks, reminders, automations/runs, routines, messages, delegations, decisions, confirmations, notification state, push subscriptions, household rules, and user-owned operational records.
   - Storage/media and derived metadata.
   - Provider-held addressable data and user-scoped provider access where supported/required.
   - Supabase Auth identity last, after dependent cleanup and evidence no longer require it.

9. **Retained/contested domains**
   - People, consent, inbound/shared-party WhatsApp evidence, deletion/audit evidence, and provider records follow the approved retention matrix rather than an assumed cascade.
   - Retained records must be minimized and logically inaccessible to ordinary product operation.

10. **Post-completion behavior**
    - Existing sessions cannot restore access.
    - Sign-in fails without revealing unnecessary account-state detail.
    - Re-registration, if ever permitted, creates a fresh account and must not revive deleted Carson memory, tasks, People, or provider bindings.

### Preserved closed foundation

- Slice A remains the canonical request/state/freeze foundation.
- Slice B remains the canonical in-flight and scheduled-work cancellation foundation.
- Slice C remains the canonical relational/Carson deletion foundation.
- Their server-derived identity, RLS, service-role-only destructive RPCs, lease fencing, idempotency, ordering, isolation, and evidence distinctions are mandatory invariants.

### Implementation or verification requiring later work

| Obligation | Current disposition |
|---|---|
| Native/web Delete Account initiation and lifecycle UI | **FIX BEFORE RELEASE** |
| Reauthentication mechanism and UX | **BLOCKED — OWNER DECISION REQUIRED** |
| Real QStash cancellation proof | **KEEP — VERIFIED REQUIRED** |
| Storage/media cleanup | **FIX BEFORE RELEASE** — authoritative workstream is Slice D, which is not authorized here |
| Provider deletion/revocation | **BLOCKED — PROVIDER EVIDENCE REQUIRED** |
| People/consent treatment | **BLOCKED — LEGAL/POLICY DECISION REQUIRED** |
| Inbound/shared-party WhatsApp evidence | **BLOCKED — LEGAL/POLICY DECISION REQUIRED** |
| Audit/deletion-evidence retention | **BLOCKED — LEGAL/POLICY DECISION REQUIRED** |
| Supabase Auth identity/session deletion | **FIX BEFORE RELEASE** — authoritative workstream is the final downstream identity slice |
| Native session/APNs lifecycle | **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED** |

## D. Deletion timeframe and public wording

### Current wording and location

`ra7etbal-v2/src/routes/Privacy.tsx` currently says:

> You can request deletion of your account and all associated data at any time by contacting us at support@ra7etbal.com. We will delete your data within 30 days of your request.

The categorical promise is also asserted by `src/routes/Privacy.test.ts`.

### Why the promise cannot yet be proven

- No user-facing Delete Account initiation or lifecycle UI exists.
- Slice D Storage/media deletion is not implemented or authorized.
- Provider deletion/revocation behavior and evidence are unresolved.
- Supabase Auth identity/session deletion is a later downstream slice.
- People and consent require policy/legal treatment.
- Inbound WhatsApp evidence has shared-party ownership and immutable-row constraints.
- Audit/deletion-evidence retention has no approved duration.
- Real QStash cancellation still requires retained production evidence.
- The end-to-end terminal-state SLA has not been demonstrated.

### Recommended interim wording for owner/legal review — do not publish yet

> You may request deletion of your Ra7etBal account and associated personal data through the account-deletion option provided in the app or by contacting support. After we verify the request, we will restrict further account activity and process deletion in stages. We will tell you when the process is complete. Some limited records may be retained where required by law or under a documented security or rights-protection policy, and some service providers may retain information under their own applicable retention requirements. We will describe any applicable retention and expected timing transparently.

This draft intentionally makes no fixed-duration promise. Legal/policy review must determine whether a duration can or must be stated and which exceptions are lawful in each release territory.

### User-visible timing contract

- Acknowledge the request immediately after durable creation.
- Show that the account is restricted and deletion is in progress.
- Give an estimated range only when operational evidence supports it.
- If a provider or policy decision blocks completion, show a safe pending/support state rather than restarting or claiming completion.
- Send or display final confirmation only after the terminal evidence contract is satisfied.

## E. Retention-exception matrix

No duration or legal authority is decided here.

| Data category | Apparent owner / data subject | Other affected parties | Current technical treatment | Deletion impact | Why retention might be considered | Review | Technical closure after policy |
|---|---|---|---|---|---|---|---|
| People records | Account owner and named person | Household/staff/contact | Retained after Slice C | Names, phones, email, roles, relationships and notes survive | Shared-party rights, dispute/support context; no established basis yet | **LEGAL/POLICY DECISION REQUIRED** | Encode DELETE or minimized retention; prove tenant-safe handling and no product reuse |
| WhatsApp consent evidence | Owner and consenting contact | Message recipient, Meta | `whatsapp_consent_log` retained after Slice C | Consent/authorization evidence survives | Demonstrating lawful/authorized messaging | **LEGAL/POLICY DECISION REQUIRED** | Define fields, authority, duration, access, expiry; delete/anonymize all else |
| Inbound WhatsApp/shared-party evidence | Sender and account owner | Meta and possibly referenced people | Immutable table; no direct owner key; 35 rows previously observed, including unresolved attribution | Cannot safely perform per-account deletion today | Fraud/security, communication integrity, sender rights | **LEGAL/POLICY DECISION REQUIRED** | Establish authoritative ownership mapping and unresolved-row rule; controlled privileged delete/anonymize design only after approval |
| Audit/security evidence | Owner plus system/operator | Contacts affected by actions | Some evidence intentionally survives task/person deletion; Slice A–C lifecycle evidence remains | Full deletion may remove replay/security proof; indefinite retention is also unjustified | Abuse prevention, incident response, legal defense | **LEGAL/POLICY DECISION REQUIRED** | Define a minimal field manifest, restricted access, duration/review trigger and terminal purge |
| Deletion request/evidence | Deleted account owner | Operator and processors | Request, transition, cancellation/resource evidence retained to orchestrate later stages | Deleting too early destroys proof and resumability | Proving request, isolation, stage completion and exceptions | **LEGAL/POLICY DECISION REQUIRED** | Retain only bounded metadata, never deleted content; set expiry/review and purge mechanism |
| Provider records | Owner and anyone named in transmitted content | Provider and communication recipients | Provider-controlled; cleanup identifiers captured where available | Provider copies/logs may survive local deletion | Provider security, abuse prevention, contractual/legal requirements | **BLOCKED — PROVIDER EVIDENCE REQUIRED** plus legal review | Provider-specific revoke/delete/expiry contract; record result/limitation without sensitive payloads |
| Legally required records, if any | Depends on record | Depends on transaction/territory | No canonical category or duration established | Unknown | Statutory duties may exist, but none are invented here | **LEGAL/POLICY DECISION REQUIRED** | Counsel identifies exact category, authority, geography, duration and minimization; engineering implements only that bounded rule |

## F. Canonical processor / App Privacy inventory

Classification reflects reachable code plus recorded production evidence. Presence in a package alone is not treated as proof of production use.

| Processor | Applicability | Purpose and transfer | Personal/user content | Deletion/retention dependency | Apple/consent effect | Remaining evidence |
|---|---|---|---|---|---|---|
| Supabase | **ACTIVE PRODUCTION PROCESSOR** | App/server -> Auth, Postgres and Storage; identity, profile, operational records, messages, memory, tokens, files | Yes; broad account content and identifiers | Storage, Auth/session and backup/retention stages remain | App Privacy: identifiers, contact data, user content, product interaction and other applicable categories | Live backup/log retention and final Auth/Storage evidence |
| Vercel | **ACTIVE PRODUCTION PROCESSOR** | Device/provider -> hosted frontend/functions; request metadata, payloads processed by APIs, deployment/function logs | User content may transit functions; logs should be minimized | Log retention and user-addressable deletion unclear | App Privacy/privacy policy must account for hosting/processing where applicable; no blanket AI consent | Provider/config retention evidence |
| ElevenLabs | **ACTIVE PRODUCTION PROCESSOR** | App/server <-> conversational voice service; audio, transcript/context, conversation identifiers and responses | Yes | Conversation deletion/retention and live agent configuration unresolved | Explicit third-party AI disclosure/consent required before applicable transfer | Live config, retention/training terms, deletion API/result semantics |
| Anthropic | **ACTIVE PRODUCTION PROCESSOR** | Server -> AI text/reasoning endpoints; prompts can include tasks, messages, People context, images/evidence and Carson context | Yes | Provider retention/training/deletion settings unresolved | Explicit third-party AI disclosure/consent required | Live routing/config and provider contractual/API evidence |
| OpenAI | **ACTIVE BUT CONDITIONAL** | Server -> transcription endpoint for user-recorded audio; Agents-based attention path exists but live flag/routing needs evidence | Audio and derived transcript; context if optional agent path is enabled | App keeps transcription body in memory, but provider retention/deletion requires verification | Explicit AI disclosure/consent if the path is offered; App Privacy must include reachable shipped behavior | Production flag/routing, retention/ZDR/training and deletion evidence |
| Meta / WhatsApp Cloud API | **ACTIVE PRODUCTION PROCESSOR** | Server <-> Meta; phone numbers, task/delegation/reminder/message content, media and delivery IDs/status | Yes, including third-party recipients | Recipient copies and some provider records may not be recallable; provider deletion limits unresolved | App Privacy disclosure required; consent/authority for recipient communication remains distinct from AI consent | Provider retention/deletion and media handling evidence |
| Google Calendar / OAuth | **ACTIVE BUT CONDITIONAL** | User-authorized app/server <-> Google; OAuth credentials and calendar event metadata/content | Yes when connected | Revoke access and delete local tokens/state; do not delete external calendar events incidentally | App Privacy reflects optional calendar/account content; contextual connection consent | Revocation evidence, live scope/config and token-retention behavior |
| Upstash QStash | **ACTIVE PRODUCTION PROCESSOR** | Server -> scheduler; callback URLs, task/run identifiers, timing, signed/auth metadata | Primarily identifiers/metadata; payloads may correlate to user work | Cancel scheduled messages; provider retention/log behavior unresolved | App Privacy/privacy disclosure depends on final data mapping; not AI consent | Real cancellation confirmation and provider retention evidence |
| Web Push transport | **ACTIVE BUT CONDITIONAL** | Server -> browser push endpoint; endpoint/keys, device/installation metadata and notification payload | Yes if payload contains task text | Delete subscription rows and suppress jobs; transport delivery/log limits remain | App Privacy may include device identifiers/product interaction/user content; permission required | Exact transport/provider path and retention evidence; native APNs later |
| Open-Meteo | **ACTIVE BUT CONDITIONAL** | Server -> geocoding/weather APIs; user-selected city and network/request metadata | City may be personal/contextual; no app credential sent | Local city is deleted with profile; provider log policy unknown | Disclose if shipped/active; no AI consent | Provider logging/retention policy and actual production-use evidence |
| Google Fonts | **ACTIVE PRODUCTION PROCESSOR** for current web asset loading | Device -> Google font domains; IP, user agent, referrer/request metadata | No Carson message payload intended | Not account-addressable; provider logging applies | Include in web disclosure assessment; native app may eliminate it | Decide self-hosting/minimization versus continued remote loading |
| Twilio | **EVIDENCE REQUIRED** | Conditional direct HTTP SMS fallback code; phone number, message content and provider IDs if enabled | Yes if active | Would require provider retention/deletion and consent/disclosure treatment | App Privacy and processor disclosure only if the production/native release enables it | Production flag and credential-presence evidence; if absent, classify NOT APPLICABLE for release |

### Canonical disclosure rule

App Privacy answers and public disclosures must be derived from the final shipped client plus reachable production backend behavior, including optional features users can activate. They must be updated when a provider, purpose, data category, linkage, tracking behavior, or retention contract materially changes.

## G. Third-party AI consent contract

### Approved product direction

1. **Trigger**
   - Present consent before the first Carson interaction that would send personal data to a third-party AI provider.
   - Do not send a “sample,” opening context, microphone audio, transcript, message, memory, image, or document before consent is recorded.

2. **Disclosure content**
   - Explain that Carson uses third-party AI services to understand and respond.
   - Name currently applicable providers or present a maintained provider list immediately accessible from the consent surface.
   - Identify the categories that may be sent: typed text; microphone audio and transcripts; images/documents when deliberately attached; tasks, reminders, calendar context, People/household information, messages, preferences, Carson memory, and necessary operational context.
   - Explain purposes, material retention limitations, and where more detail is available.

3. **Scope**
   - Base consent is account-level for the core typed/voice Carson service and is versioned.
   - Optional sensitive modalities require contextual action: attaching an image/document or starting voice clearly authorizes that modality only after the base disclosure is accepted.
   - Consent does not authorize unrelated analytics, advertising, model training, contact uploads, or new processors/purposes.

4. **Voice/text equivalence**
   - Typed and voice Carson use the same consent authority, provider disclosure, reasoning/skill boundaries, and withdrawal state.
   - Refusal must not create an advisory-only typed Carson or a separate voice Carson.
   - If core provider processing is refused, both provider-dependent typed and voice Carson stop consistently. Non-AI account/settings/history functions may remain available where they do not trigger the refused transfer.

5. **Data minimization and authority**
   - Send only context necessary for the user’s current request and protected execution path.
   - Tool/provider availability is not authority to disclose personal data.
   - Existing access to People, messages, calendar or memory is not blanket permission to send all of it.
   - Material ambiguity narrows or stops the transfer and requests authorization.

6. **Evidence**
   - Record user ID, consent-contract version, accepted/declined state, timestamp, surface, locale, and relevant provider/data-category version.
   - Do not copy the user’s messages, audio, contacts, or other sensitive payloads into the consent log.
   - Consent evidence is tenant-scoped and protected by RLS/server authorization.

7. **Withdrawal**
   - Settings provides a clear withdrawal control.
   - Withdrawal prevents new provider-bound Carson processing; it does not falsely claim deletion of already processed provider data.
   - Existing pending provider-bound operations must fail closed or be reconciled according to evidence state.
   - Provider deletion/revocation follows the deletion/provider contract where applicable.

8. **Re-consent**
   - Require re-consent for a materially new AI provider, new sensitive data category, new purpose, materially different retention/training use, or change that increases disclosure.
   - Do not re-prompt for immaterial wording/layout changes.

9. **Refusal/recovery**
   - Explain neutrally which Carson capabilities require provider processing.
   - Preserve access to privacy settings, deletion, support, and non-provider account data.
   - A later voluntary acceptance restores both typed and voice provider-dependent Carson under the same C-01 contract.

10. **Consistency**
    - Consent text, privacy policy, App Privacy answers, provider inventory, deletion contract, and actual routing must describe the same behavior.

### Legal/policy review required

- Exact disclosure wording and whether providers must be named on the first surface.
- Territory/age-specific consent requirements.
- Lawful basis beyond Apple review requirements.
- Provider training/retention representations.
- Treatment of personal data concerning People, staff, contacts and message recipients.
- Consent-record retention after account deletion.
- Whether any non-consent lawful exception exists; none is assumed here.

## H. Notification privacy default

### Approved default

- Lock-screen title: **Ra7etBal** or **Carson**.
- Generic body examples: **You have a reminder**; **Carson needs your attention**; **An update is ready**.
- Do not include task descriptions, names, household details, calendar details, message contents, delegation instructions, proof details, or confidential/personal content by default.
- Tapping opens the authenticated in-app destination. The notification is not the authoritative evidence of delivery or completion.

### Optional previews — not yet approved for implementation

- A later per-device setting may allow descriptive previews after a clear explanation.
- Preview opt-in must not change the stored task/message or Carson execution semantics.
- Logout, account switch, token rotation, device removal and deletion disable the old device’s subscription.
- OS-level preview settings remain authoritative; Ra7etBal must function when notification permission or previews are disabled.

### Required states

- Permission is requested in context, after the user chooses to enable notifications.
- Denial/revocation does not block core app use.
- Reminders and attention items remain discoverable in-app.
- Provider acceptance is not displayed as device delivery unless evidence supports that claim.

Implementation is **FIX BEFORE RELEASE**; native APNs verification is **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED**. Notification code is unchanged by this pack.

## I. App reviewer access contract

1. Create a dedicated reviewer account and isolated tenant only after owner authorization.
2. Use synthetic names, phone numbers, tasks, reminders, calendar entries, messages, images, and Carson memory. Never seed real household or real-user data.
3. Credentials must remain valid for the expected review window and be monitored without bypassing ordinary authentication.
4. Backend services required for review must be reachable and use release-equivalent configuration.
5. Review notes explain:
   - invite-only access and supplied credentials;
   - ONE CARSON / one chat / typed and voice inputs;
   - how to test reminders, delegations, confirmations, Notifications and Communication History;
   - which provider-dependent operations use safe reviewer/test recipients;
   - how to initiate and observe account deletion without using a real account;
   - any unavoidable timing or external-provider limitations.
6. Voice and text must exercise the same identity, reasoning, tools, approvals, history and outcome semantics.
7. Consequential actions must target controlled test resources only. No real WhatsApp contact, calendar, reminder recipient or external person may be affected.
8. Provider test modes must be truthful: simulated acceptance must not be represented as real-world delivery.
9. Reviewer deletion tests use a disposable reviewer clone or resettable test tenant, not a shared credential whose deletion locks Apple out mid-review.
10. Reviewer authorization remains ordinary tenant-scoped authorization. No magic user ID, hidden universal password, RLS bypass, debug entitlement or production admin route is permitted.
11. After review, credentials are rotated/revoked through the normal owner-controlled process and evidence is recorded.

Current disposition: **FIX BEFORE RELEASE**. The reviewer-access approach is owner-approved; account creation is not required and remains unauthorized.

## J. Future native-iOS acceptance criteria

Nothing in this section is marked PASS before the exact Release/TestFlight candidate exists.

### Account and privacy

- [ ] Frozen release explicitly implements the approved invite-only or account-creation decision.
- [ ] Recovery, logout, expired-session, reinstall and account-switch behavior are tenant-safe.
- [ ] Delete Account is easy to find, distinct from Clear History, authenticated, confirmed and server-derived.
- [ ] Requested, in-progress, partial/blocked, retrying, support and completed deletion states are truthful.
- [ ] Completion is impossible before the approved Storage, provider, policy and Auth stages reach terminal evidence.
- [ ] Third-party AI consent occurs before any covered transfer; refusal and withdrawal are enforced equally for voice and text.
- [ ] Privacy policy, in-app consent, provider inventory and App Privacy answers agree with runtime behavior.

### Permissions and notifications

- [ ] Microphone, camera/photos, files and notifications are requested only when needed with accurate purpose strings.
- [ ] Denial, later grant, revocation and restricted states have usable recovery paths.
- [ ] Contacts/location/background capabilities are absent unless separately approved and justified.
- [ ] Generic notification previews are the default; any descriptive preview is an explicit per-device opt-in.
- [ ] APNs tokens rotate correctly and are removed on logout, account switch, device removal and deletion.
- [ ] The app remains useful and attention/reminder state remains discoverable when notifications are disabled.

### Build, SDK and security

- [ ] Version, build, immutable Git SHA, dependency lock, backend deployment, feature flags and model/provider configuration are recorded.
- [ ] Release/Archive build is signed with the approved team, bundle ID, profiles and minimum entitlements.
- [ ] Privacy manifest matches the final native target and collected-data behavior.
- [ ] Every required-reason API has an approved declared reason.
- [ ] Every third-party SDK version has the required manifest/signature and is included in the canonical inventory.
- [ ] Debug/internal routes, logging and diagnostics are excluded or strongly authorized in Release.
- [ ] RLS, tenant isolation, authorization, reauthentication, replay/idempotency and protected consequential flows pass.
- [ ] No secret, development endpoint or test bypass is embedded in the archive.

### Accessibility and localization

- [ ] VoiceOver labels, values, actions, headings and status announcements are complete.
- [ ] Dynamic Type/Larger Text works without clipping or lost actions.
- [ ] Focus order, modal trapping/restoration and keyboard/switch navigation are correct.
- [ ] Contrast, touch targets, reduced motion and non-color-only status communication pass.
- [ ] Arabic/RTL, mixed-direction content and localized permission/consent/deletion copy pass on device.

### Resilience and Carson protections

- [ ] Fresh install, upgrade, logout/login, recovery, reinstall and multi-device sessions pass.
- [ ] Normal, cellular, constrained, offline-start and network-loss-mid-action states pass.
- [ ] Background/foreground, interruption, termination/relaunch, voice interruption and audio-route changes pass.
- [ ] Repeated taps, retries after timeout, provider degradation and unknown provider results do not duplicate consequential actions.
- [ ] Typed and voice remain one Carson with equivalent identity, reasoning, tools, approvals, history and outcome semantics.
- [ ] Attempted is not presented as completed; provider acceptance is not presented as delivery without evidence.
- [ ] Drafts and pending user intent survive or fail safely according to the approved contract.

### Submission evidence

- [ ] Non-development TestFlight testers complete critical flows on supported real devices.
- [ ] Dedicated reviewer access and review notes are verified against the exact build.
- [ ] App Privacy answers are approved and match client/backend/provider behavior.
- [ ] Screenshots/previews show the shipped UI and contain no real personal data.
- [ ] Name, subtitle, language, category, SKU, age rating, rights, territories, pricing, copyright, description, keywords and support/privacy URLs are approved.
- [ ] Export-compliance answers reflect the final archive.
- [ ] Privacy-safe crash/performance evidence exists without an unauthorized analytics SDK.
- [ ] Protected tests, security tests and the full real-device release matrix pass with retained evidence.

Current disposition for this checklist: **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED**.

## K. No-floating-work reconciliation

| Finding | Current disposition | Authoritative workstream/register | Closure prerequisite |
|---|---|---|---|
| Email/password first-party authentication / no present Sign in with Apple trigger | **PASS — VERIFIED** | 33B Apple investigation | Reassess only if third-party/social primary login is added |
| Public UGC/community moderation | **NOT APPLICABLE** | 33B Apple investigation | Reassess if public sharing/community is introduced |
| Invite-only authorization and tenant isolation | **KEEP — VERIFIED REQUIRED** | Protected behavior registry / launch control | Preserve in native client and reviewer tenant |
| iOS access model decision | **PASS — VERIFIED** | This decision pack / 33B | Owner approved `INVITE_ONLY_SIGN_IN`; reopen only on a new owner decision |
| Native enforcement of invite-only/sign-in-only | **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED** | 33B native release gate | Prove client and server enforce the approved model in the exact RC |
| Reviewer account and notes | **FIX BEFORE RELEASE** | 33B reviewer-access gate | Create isolated synthetic reviewer path and verify exact RC |
| Slices A–C | **PASS — VERIFIED** | Phase 3E/3F/3G closure registers | Reopen only on contradictory production evidence |
| In-app Delete Account initiation/status | **FIX BEFORE RELEASE** | Account-deletion UX slice / 33B | Approved contract plus client implementation and tests |
| Storage/media deletion | **FIX BEFORE RELEASE** | Account Deletion Slice D | Separate explicit authorization, implementation and production evidence |
| Provider deletion/revocation | **BLOCKED — PROVIDER EVIDENCE REQUIRED** | 33A provider register | Provider-specific policy/API/config and result semantics |
| Supabase Auth/session deletion | **FIX BEFORE RELEASE** | Final account-deletion identity slice | All dependencies terminal; Auth last |
| People/consent | **BLOCKED — LEGAL/POLICY DECISION REQUIRED** | 33A retention register | Approved treatment, duration and minimization |
| Inbound/shared-party WhatsApp evidence | **BLOCKED — LEGAL/POLICY DECISION REQUIRED** | 33A retention register | Ownership mapping and retention/deletion policy |
| Audit/deletion-evidence retention | **BLOCKED — LEGAL/POLICY DECISION REQUIRED** | 33A retention register | Purpose, fields, authority, duration and purge rule |
| Real QStash cancellation | **KEEP — VERIFIED REQUIRED** | Slice B/3G closure register | Disposable production scheduled-message proof |
| Public 30-day deletion wording | **BLOCKED — LEGAL/POLICY DECISION REQUIRED** | 33A privacy-policy closure | Approved truthful wording plus supportable lifecycle/SLA |
| Processor/App Privacy inventory accuracy | **FIX BEFORE RELEASE** | 33A processor matrix / 33B App Privacy | Final production/native inventory and approved disclosures |
| Twilio applicability | **BLOCKED — PROVIDER EVIDENCE REQUIRED** | 33A processor matrix | Production flag/credential-presence evidence |
| Third-party AI consent product direction | **PASS — VERIFIED** | This decision pack / 33A | Owner approved explicit, versioned, limited, withdrawable, voice/text-equivalent consent |
| Third-party AI consent implementation | **INACTIVE FOUNDATION — PR #443; REAL-POSTGRES PROOF IN REQUIRED TIER-1 MERGE GATE** | 33A AI consent contract / 33B | Production migration requires separate owner authorization; activation, legal/provider inputs and release-candidate verification remain separate |
| Notification lock-screen privacy direction | **PASS — VERIFIED** | This decision pack / 33C | Owner approved generic privacy-preserving content by default |
| Notification lock-screen privacy implementation | **IMPLEMENTATION COMPLETE AND DEPLOYED; PRODUCTION CODE-PATH VERIFICATION COMPLETE; PHYSICAL PRODUCTION DISPLAY/TAP VERIFICATION BLOCKED — SAFE DISPOSABLE PUSH-ENABLED IDENTITY/DEVICE REQUIRED** | 33C notifications | PR #442 / merge `ab5d1a0d0ecffda6c201192f31b17774424c17e6`; do not create a canary account/infrastructure solely for this evidence; close physical evidence only when a suitable disposable reviewer/canary identity and dedicated device/runtime naturally exist; native APNs/TestFlight evidence remains separate |
| Notification permission/fallback/delivery truth | **KEEP — VERIFIED REQUIRED** | Protected notification/reminder work | Real-device APNs and disabled-notification verification |
| Native permissions, APNs, manifests, SDK signatures, signing and entitlements | **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED** | 33B native release gate | Exact Archive/TestFlight evidence |
| Accessibility | **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED** | 33C accessibility gate | Real-device VoiceOver, Dynamic Type, focus, contrast, target, motion and announcement evidence |
| Mobile resilience | **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED** | 33C real-device resilience gate | Execute the approved matrix on the exact RC |
| Release debug-surface exclusion | **FIX BEFORE RELEASE** | 33B security/release-build gate | Prove exclusion/authorization in Release build |
| App Store business metadata, age/audience, rights, territories and pricing | **BLOCKED — OWNER DECISION REQUIRED** | 33B submission package | Owner decisions and any required legal review |
| Screenshots, build-linked metadata and export-compliance evidence | **BLOCKED — NATIVE RELEASE CANDIDATE REQUIRED** | 33B submission package | Exact-build assets and archive assessment |
| Payments/subscriptions | **FUTURE WORK — DO NOT BUILD YET** | Future commerce workstream | Separate business/legal decision and Apple commerce assessment |
| Analytics/crash SDK | **FUTURE WORK — DO NOT BUILD YET** | Privacy-safe measurement / native release evidence | Do not add without explicit authorization and disclosure review |

No new competing workstream is created. This pack is the decision layer over the existing 33A privacy/data-governance, account-deletion, 33B App Store, 33C mobile-quality, protected-behavior, and provider-evidence registers.

## L. Current bounded implementation status

### Notification-content privacy — deployed; physical display evidence dependency remains open

PR #442, merged as `ab5d1a0d0ecffda6c201192f31b17774424c17e6`, replaces sensitive task/person/calendar/communication content in all five current Production Web Push producer paths with the approved generic wording. The payload allow-list is verified, and the deployed Production service worker independently constructs the same generic display copy. Opaque authenticated routing and delivery-evidence fields remain intact; detailed content remains available only through the existing authenticated in-app records.

Why this slice was selected:

- It closes a real **FIX BEFORE RELEASE** obligation.
- Product direction is fully decided.
- It does not require a legal retention period, final privacy-policy wording, provider-deletion evidence, Slice D, Auth changes, a schema change, or a native release candidate.
- It is smaller and safer than exposing an irreversible deletion UI before the full deletion lifecycle can reach completion.
- It is less assumption-dependent than AI consent implementation, whose exact user-facing wording, provider representations and consent-evidence retention still require legal/provider inputs.
- It changes presentation content only; reminder scheduling, QStash, delivery evidence, notification permission, retries, Carson attention state and in-app discoverability remain protected.

Completed protection evidence:

1. Focused privacy/producer/service-worker tests: 202/202 passed.
2. Protected pretest: 126/126 passed; impact map: 35/35 passed; state integrity: 22/22 passed; registry validation passed.
3. Typecheck and production build passed.
4. Current-main full protected suite: 2,831 passed, 4 skipped, 3 todo, zero failures.
5. Diff inspection confirms no change to reminder timing, QStash/pg_cron, subscription lifecycle, permission prompts, delivery evidence, retries, authentication, RLS, schema, Carson routing, WhatsApp, or authenticated in-app content.
6. Production code-path verification confirms the deployed generic payload and service-worker construction.

Physical Production display/tap verification has not been performed and must not be described as PASS. It is **BLOCKED — SAFE DISPOSABLE PUSH-ENABLED IDENTITY/DEVICE REQUIRED**. Per owner decision, no disposable Production Auth account/device or additional canary infrastructure will be created solely to close this evidence gap. The implementation must not be reopened without contradictory evidence. Native APNs/TestFlight notification verification remains separately blocked on the exact native release candidate, and richer previews remain unimplemented and unauthorized. Slice D, Auth changes, privacy-policy publication, provider deletion, Google Play work, agentic-safety verification and cumulative public-release review remain unauthorized.

## Boundary confirmation

- Production mutation: none.
- Database/schema/RLS/Auth changes: none.
- Slice D or Storage deletion: none.
- Provider deletion/revocation/configuration: none.
- Notification behavior changes: generic external Web Push display content is deployed through PR #442 / `ab5d1a0d0ecffda6c201192f31b17774424c17e6`; scheduling, routing, evidence and authenticated in-app content remain unchanged. Physical Production display/tap verification remains blocked on a safe disposable push-enabled identity/device.
- Native iOS/App Store Connect work: none.
- Privacy-policy publication: none.
- Payment/analytics implementation: none.
- Deployment/merge: none.
