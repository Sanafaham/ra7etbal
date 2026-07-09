RA7ETBAL MASTER PLAN UPDATE

OS 1.6 – DAILY EVIDENCE LOG

Date: 2026-07-04

Status: COMPLETE

──────────────────────────────

SESSION OBJECTIVE

Stabilize Quality Intelligence proof photo workflow and investigate Carson voice response latency.

──────────────────────────────

WHAT WAS BUILT

• Multi-Photo Proof Upload V1
• Multi-Photo Quality Intelligence Review
• Proof Photo Reupload Flow
• Proof Photo Replacement Logic
• Daily Evidence Log operating procedure

──────────────────────────────

WHAT WAS FIXED

• Proof photo upload failures after Quality Intelligence rejection
• Supabase proof photo overwrite conflict
• Multi-photo proof submission handling
• Proof photo replacement and resubmission workflow

──────────────────────────────

ROOT CAUSE IDENTIFIED

Proof photos were uploaded to a fixed storage path without proper overwrite handling.

When a task was rejected and Christopher attempted to upload corrected proof photos, Supabase rejected the replacement upload because the file already existed.

This caused the proof photo reupload failure.

──────────────────────────────

SAFETY PROCEDURES ADDED

• Multi-photo upload validation
• Proof photo replacement protection
• Reupload protection
• Regression test coverage
• Build verification
• Production deployment verification

──────────────────────────────

WHAT WAS TESTED

• Single proof photo upload
• Multiple proof photo upload
• Quality Intelligence rejection workflow
• Corrected proof photo resubmission
• Legacy task compatibility
• Full application regression suite

──────────────────────────────

PRODUCTION VERIFICATION

Verified:

• Multi-photo proof uploads deployed
• Quality Intelligence rejection flow working
• Corrected resubmission flow working
• Task returned successfully for owner review
• Production deployment completed

Commit:
58196c7

Deployment:
dpl_8xT2cJw4jF122XDgZeAqWYih1mfF

Status:
READY

──────────────────────────────

CARSON VOICE INVESTIGATION

Investigated:

• Eagerness settings
• Turn-taking settings
• Soft timeout settings
• LLM timeout settings
• Expressive Mode availability

Findings:

• Eagerness already set to maximum
• Turn-taking already set to 1 second
• Soft timeout currently disabled
• Expressive Mode available but not enabled
• No production voice changes deployed today

──────────────────────────────

OPEN ITEMS

1. Continue observing Carson response speed during normal usage.

2. Collect real-world examples of:
   • Slow responses
   • Long pauses
   • Interruptions
   • Conversation flow issues

3. Decide whether to enable:
   • Expressive Mode
   • Soft Timeout

4. Continue monitoring Multi-Photo Proof Upload V1 in production.

──────────────────────────────

END OF DAY STATUS

Completed:
• Multi-Photo Proof Upload V1
• Proof Photo Reupload Fix
• Quality Intelligence Review Flow Validation
• Carson Voice Investigation

No active blockers.

Ready for next development session.

──────────────────────────────

GITHUB PAGES DEPLOYMENT HYGIENE

Investigated:

• GitHub Actions email for failed "pages build and deployment"
• Repository Actions history
• Failed deploy job logs
• GitHub Pages artifact contents
• GitHub Pages public URLs
• Current Pages workflow setup
• Vite base config
• Vercel production URL safety

Findings:

• Failed workflow belonged to Sanafaham/ra7etbal
• Failed run: https://github.com/Sanafaham/ra7etbal/actions/runs/28686356729
• Build and report-build-status succeeded
• Deploy failed with: "Deployment failed, try again later."
• Rerunning the failed deploy job succeeded
• GitHub Pages is not the Ra7etBal production deployment surface
• Production remains Vercel: https://ra7etbal.com
• GitHub Pages automatic root publish creates a legacy/static nested path:
  https://sanafaham.github.io/ra7etbal/ra7etbal/
• Root Pages URL still 404s:
  https://sanafaham.github.io/ra7etbal/

Change:

• Added README deployment note clarifying that production is Vercel only and
  GitHub Pages must not be used for app routing, APIs, auth callbacks,
  WhatsApp confirmation links, or production verification.

No code changed.
No GitHub Pages settings changed.
No Vercel, DNS, Supabase, auth, WhatsApp, ElevenLabs, secrets, env vars, or
production app settings changed.

──────────────────────────────

QUALITY INTELLIGENCE V1 STABLE STATUS

Date:
2026-07-05

Status:
Done, deployed, production verified, STABLE

Production verification task:
b8798eee-240f-48be-91dc-904f41b588a1

Verified behaviors:

• Proof-required guard blocked photo delegation completion without proof.
• Wrong proof returned correction_required.
• WhatsApp correction was sent through the existing direct_message path.
• Owner was not notified on correction_required.
• fraud_suspected protection stayed active for reused/suspicious proof.
• Correct proof returned approved.
• Approved proof marked the task done.
• Owner was notified after approval.
• No duplicate task was created.
• Inbox Review remained untouched.
• Already-done tasks were protected from re-review and re-confirmation.

Safety caveat:

Low risk remains for simultaneous duplicate POST race before the first write
lands, and repeated direct API calls on pending correction states can create
repeated correction messages. The UI prevents ordinary accidental repeats.

Recommendation:

• Disable GitHub Pages for Sanafaham/ra7etbal only after Sana confirms no
  legacy/static preview is needed.

GITHUB PAGES DISABLED

Changed:

• Disabled GitHub Pages for Sanafaham/ra7etbal in GitHub repository settings.
• Set Pages source branch to None.
• Updated README deployment note to say GitHub Pages is intentionally disabled
  because production runs on Vercel.

Evidence:

• GitHub settings showed: "GitHub Pages source saved."
• GitHub settings source form showed: "GitHub Pages is currently disabled.
  Select a source below to enable GitHub Pages for this repository."

Not touched:

• No app code changed.
• No Vercel, DNS, Supabase, auth, WhatsApp, ElevenLabs, secrets, env vars, or
  production app settings changed.

──────────────────────────────

CLEAR MY HEAD ROUTING + DUPLICATE SUBMIT BUTTON FIX

Date:
2026-07-10

Status:
Fixed, deployed, production reachable (HTTP 200 verified). Live interactive
verification (real account, real photo upload, real iPhone PWA keyboard
state) not performed this session — no browser session/credentials
available in this environment.

Regressions confirmed reproducible:

1. Clear My Head routing regression — "Ask Christopher to make this for
   lunch" with a photo attached did not reliably route to delegation.
2. Clear My Head duplicate submit button on iPhone PWA.

Root cause 1 — Routing:

The deterministic direct-recipient safety net in
src/lib/ai/role-precedence.ts (getDirectRecipientInstruction) used regex
patterns ending in `(?<rest>.*)$` without the dotAll flag. Home.tsx appends
"\n\nAttached image:\n<description>" to the extraction text whenever a
photo is attached. Once that blank line was present, `.` could never cross
it and `$` could never be reached, so the match silently failed. Without
that safety net firing, the item fell through to whatever the raw model
extraction guessed, which was observed to land on "parked" (Inbox) instead
of delegation. This is a different bug from the one fixed in commit
dbb20be (which fixed missing note/todo routing for the photo-only
extraction path in extract-photo.ts) — role-precedence.ts was untouched by
that earlier fix and had zero regression coverage before this session.

Root cause 2 — Duplicate submit button:

Home.tsx always rendered the inline `home-submit-button`, and separately
rendered a floating `home-sticky-cta-button` whenever `keyboardOpen` was
true (textarea focused or visualViewport shrunk). Nothing hid the inline
button when the sticky one appeared, so both were mounted and visible at
once. This pattern has existed since the sticky CTA was first introduced
(long-standing, not a recent regression).

Fix:

• role-precedence.ts — getDirectRecipientInstruction now matches only
  against the first paragraph of sourceText (split on the first blank
  line), so appended photo-description context can never break the match,
  and appended text can never leak into the generated recipient message.
• Home.tsx — the inline submit button is now gated on `!keyboardOpen`, so
  exactly one "Clear My Head" submit control is ever visible; the sticky
  CTA (gated on `keyboardOpen`) remains reachable above the iOS keyboard.

Tests added:

• src/lib/ai/role-precedence.test.ts (new) — 5 tests: plain "ask X to..."
  still routes to delegation; routes to delegation with an appended photo
  description; appended description text does not leak into the generated
  message; "remind me to ask X..." exclusion still holds with a photo
  attached; role+topic promotion (Cook + dinner) still fires with a photo
  attached.
• src/routes/Home.test.ts (new) — 3 tests, source-scan pattern matching the
  existing Review.no-persistence.test.ts / Updates.test.ts convention:
  inline button gated on !keyboardOpen, sticky CTA gated on keyboardOpen,
  mutual exclusion of the two gates.

Commands run:

• npx vitest run src/lib/ai/role-precedence.test.ts src/routes/Home.test.ts — 8/8 passed
• npx vitest run src/lib/ai src/routes/Review.no-persistence.test.ts src/lib/save.test.ts src/routes/Home.test.ts — 55/55 passed
• npm run typecheck — passed
• npm test (full suite) — 1166/1166 passed across 92 files
• npm run build — passed (only pre-existing routine:* CSS and bundle-size warnings)

Commit:
cb2d9f4 — "Fix Clear My Head photo-context routing and duplicate submit button"

Deployment:
dpl_31CX3gy7AdptsGGymQMdHcvssz5P — READY, aliased to production
(ra7etbal-v2.vercel.app, ra7etbal.com). https://ra7etbal-v2.vercel.app
returns HTTP 200 after deploy.

Not touched:

• QI, WhatsApp templates, scheduler/cron, push subscription logic, Carson
  voice, Supabase auth/RLS, schema — none modified.

Vault note (unrelated to this fix, flagged for awareness):

Ra7etBal_Docs/CURRENT/01_ACTIVE/CURRENT_STATUS.md and
MASTER_PLAN_CURRENT.md (dated 2026-07-09) claim Phase 8.1 is next and that
Quality Intelligence still has open bugs (notification wording, attach-
another-photo). This is stale — actual git history through commit c132c32
(the session's starting HEAD) shows Phase 8 QI work is complete and past
those two items; RA7ETBAL_PROJECT_STATUS_CURRENT.md (the vault's own
higher-priority source of truth per _CLAUDE.md's ordering) is itself stale
at 2026-07-09, and was last actually updated 2026-06-29 and does not
reflect QI work at all. Vault docs were not edited this session per "docs
updated manually only when requested."

Remaining risks:

• Live interactive verification not performed (no signed-in browser
  session in this environment) — recommend Sana manually verify: (a) type
  "Ask Christopher to make this for lunch", attach a food photo, submit,
  and confirm the Review screen shows it as a delegation to Christopher;
  (b) on iPhone PWA, focus the Clear My Head textarea and confirm only one
  submit button is visible/reachable above the keyboard.
• The first-paragraph restriction assumes the user's actual instruction is
  always the first paragraph of extraction text — true for every current
  caller (Home.tsx, text-carson.ts) but would need revisiting if a future
  caller prepends context before the user's text.
