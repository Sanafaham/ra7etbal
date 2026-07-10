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

──────────────────────────────

STICKY CLEAR MY HEAD CTA — KEYBOARD POSITIONING FIX

Date:
2026-07-10

Status:
Fixed, deployed, production reachable (HTTP 200 verified on
ra7etbal-v2.vercel.app and www.ra7etbal.com).

Manual verification from Sana (iPhone PWA), after the prior duplicate-
submit-button fix:

• Duplicate submit button: confirmed fixed, only one button shows.
• New/remaining regression: the sticky CTA appears too low, is partly
  hidden behind the iOS keyboard, and visibly jumps upward when tapped.
  Explicitly scoped as a positioning regression only — no routing or
  Clear My Head flow changes requested or made.

Source of truth located:

Home.tsx owns the entire keyboardOpen / visualViewport / safe-area
pipeline; it's the only file in the codebase using window.visualViewport
(confirmed via repo-wide grep — no shared helper existed to reuse).

Root cause:

The sticky CTA used a static `bottom: calc(env(safe-area-inset-bottom) +
132px)` offset — a guessed constant standing in for the iOS keyboard's
height. Real keyboard heights vary (compact ~216px vs. QuickType/emoji
~290-350px+), so the guess routinely left the button behind the keyboard.
Separately, iOS pans the visual viewport (visualViewport.offsetTop) to
keep a focused input in view; the existing visualViewport resize/scroll
listener only tracked `window.innerHeight - vv.height` and ignored
offsetTop, so the CTA's `position: fixed` offset didn't account for that
pan — producing the reported "jumps upward when tapped."

Fix:

Extracted the inset math into a pure, exported function,
computeKeyboardInset(innerHeight, visualViewportHeight,
visualViewportOffsetTop), which returns
max(0, innerHeight - visualViewportHeight - visualViewportOffsetTop) —
the real, current gap between the layout and visual viewports. Wired into
the existing visualViewport resize/scroll effect (no new listeners
added), stored in new keyboardInset state, and used to position the
sticky CTA: `bottom: calc(env(safe-area-inset-bottom) +
${keyboardInset + 16}px)`. The keyboardOpen trigger threshold (viewport
shrink > 120px) is unchanged — only the CTA's position now reflects the
real keyboard/pan state instead of a guessed constant. Routing
(role-precedence.ts) and the rest of the Clear My Head flow were not
touched.

Tests added (src/routes/Home.test.ts, 6 new tests):

• computeKeyboardInset returns 0 with no keyboard open.
• Returns the real keyboard height for both a compact and a tall
  (QuickType/emoji) keyboard — proving a static 132px guess would have
  undershot both.
• Accounts for visualViewport.offsetTop panning.
• Never returns a negative inset.
• Source-scan: the compute effect wires computeKeyboardInset() in and
  preserves the unchanged 120px viewportShrunk threshold.
• Source-scan: the sticky CTA's bottom style uses the dynamic
  keyboardInset and no longer contains the old 132px constant.

Commands run:

• npx vitest run src/routes/Home.test.ts — 9/9 passed
• npm run typecheck — passed
• npm test (full suite) — 1172/1172 passed across 92 files
• npm run build — passed (only pre-existing routine:* CSS and
  bundle-size warnings)

Commit:
0afab6a — "Fix sticky Clear My Head CTA positioning above iOS keyboard"

Deployment:
dpl_9GBsyTqqCkDqyb8kDmgh2HmPwLXe — READY, aliased to production
(ra7etbal-v2.vercel.app, ra7etbal.com/www.ra7etbal.com). Both return
HTTP 200 after deploy.

Not touched:

• Clear My Head routing/extraction (role-precedence.ts untouched this
  fix), QI, WhatsApp templates, scheduler/cron, push subscription logic,
  Carson voice, Supabase auth/RLS, schema.

Remaining risks:

• Live interactive verification on a real iPhone PWA not performed by
  Claude in this environment (no signed-in browser session) — recommend
  Sana manually confirm the CTA sits fully visible just above the
  keyboard and does not jump when tapped, across a couple of keyboard
  types (default QWERTY, with/without QuickType/predictive bar).
• The `+ 16px` gap above the computed keyboard edge is a small fixed
  padding choice, not derived from any design token — adjust if it looks
  visually too tight or too loose in practice.

──────────────────────────────

CONFIRMATION PAGE PROOF-PHOTO BUTTON COPY FIX

Date:
2026-07-10

Status:
Fixed, deployed. Copy/state cleanup only.

Issue:

On the worker task confirmation page, before any proof photo was
attached, the disabled "Mark done" submit button said "Attach a new
photo to continue" — confusing manual testing, since "new photo" implies
a prior photo exists to replace, but none did yet.

Source of truth:

src/routes/Confirm.tsx. `needsNewProof` (line ~408) is true in two
distinct cases: (1) a task's first-ever proof (proofRequired === true,
outcome not yet set) and (2) a genuine post-rejection re-upload (outcome
"correction_required" or "fraud_suspected", where a previously submitted
photo was reviewed and rejected). The submit button's disabled label used
one unconditional string for both. The secondary upload control (line
~562) already correctly distinguished "Attach proof photo" (no photos
yet) vs. "Add another photo" (photos already attached) — only the submit
button needed the fix.

Fix:

Submit button label now branches on the same
`outcome === "correction_required" || outcome === "fraud_suspected"`
condition already used elsewhere in the file (lines ~268, ~507) for the
rejection state:
• First-ever proof (no rejection yet): "Attach proof photo to continue".
• Genuine post-rejection re-upload: "Attach a new photo to continue"
  (unchanged — accurate here, a prior photo really was rejected).

No changes to `needsNewProof`'s truthiness, QI logic, upload limits,
submission handling, or WhatsApp flow — purely a label branch.

Tests added (src/routes/Confirm.proof-copy.test.ts, new file, 4 tests):

• Submit button contains "Attach proof photo to continue" for the
  first-proof case.
• Submit button still says "Attach a new photo to continue" only inside
  the outcome-gated branch (regex match on the exact ternary structure).
• Confirms the upload control's existing correct copy is unchanged.
• Guards against a future regression reintroducing an unconditional
  "Attach a new photo to continue" string (asserts exactly one occurrence
  in the file, inside the gated branch).

Commands run:

• npx vitest run src/routes/Confirm.proof-copy.test.ts
  src/routes/Confirm.photo-upload.test.ts src/routes/Confirm.reopen-lock.test.ts
  — 27/27 passed
• npm run typecheck — passed
• npm test (full suite) — 1176/1176 passed across 93 files
• npm run build — passed (only pre-existing routine:* CSS and
  bundle-size warnings)

Commit:
01e6249 — "Fix confirmation page proof-photo button copy before a first photo"

Deployment:
dpl_AqiwUAF4otByK13TcsiiMMyCgf94 — READY, aliased to production
(ra7etbal-v2.vercel.app, ra7etbal.com/www.ra7etbal.com). Both return
HTTP 200 after deploy.

Not touched:

• QI review logic, upload limits (MAX_PROOF_PHOTOS), confirmation
  submission handling, WhatsApp flow, upload control copy (already
  correct), schema, auth/RLS.

Remaining risks:

• Live interactive verification on the real confirmation page (a real
  task with proofRequired, no outcome yet) not performed by Claude in
  this environment — recommend Sana manually confirm the button reads
  "Attach proof photo to continue" before any photo, and still reads
  "Attach a new photo to continue" after a real QI rejection.

──────────────────────────────

REVERT: CONFIRMATION PAGE PROOF-PHOTO BUTTON COPY FIX

Date:
2026-07-10

Status:
Reverted at Sana's request. Confirm.tsx restored exactly to its
pre-fix state; Confirm.proof-copy.test.ts removed.

Reason:

Sana asked to revert the proof-copy cleanup above and restore the prior
wording/state exactly, with explicit scope: Confirm.tsx copy/state only,
no QI, no WhatsApp, no upload logic, no Clear My Head. This entry is
added per the append-only log convention — the original fix entry above
is left in place as historical record, not deleted.

What was reverted:

Commit `01e6249` ("Fix confirmation page proof-photo button copy before a
first photo") via `git revert`. The submit button's disabled label is
restored to the single unconditional string "Attach a new photo to
continue" for every `needsNewProof` case (first-ever proof and
post-rejection re-upload alike) — the same wording that was live in
production before this session's cleanup.

Verification the revert is exact:

`git diff --cached` on Confirm.tsx showed only the label ternary reverting
to its prior three-line form; `git revert` applied cleanly with zero
conflicts; the resulting Confirm.tsx blob hash (`c567b0a`) matches the
pre-fix blob hash exactly, byte-for-byte.

Commands run:

• npx vitest run src/routes/Confirm.photo-upload.test.ts
  src/routes/Confirm.reopen-lock.test.ts — 23/23 passed
• npm run typecheck — passed
• npm test (full suite) — 1172/1172 passed across 92 files (test count
  and file count match the pre-fix baseline exactly)
• npm run build — passed (only pre-existing routine:* CSS and
  bundle-size warnings; CSS bundle hash unchanged, confirming the copy
  change was JS-only)

Commit:
6046c32 — Revert "Fix confirmation page proof-photo button copy before a
first photo"

Not touched:

• QI review logic, upload limits, confirmation submission handling,
  WhatsApp flow, Clear My Head, schema, auth/RLS.

Remaining risks:

• None beyond the original pre-fix state — the confusing "Attach a new
  photo to continue" wording before a first proof photo is back, by
  explicit request, pending a future decision on how to address it.

──────────────────────────────

QI: STOP REJECTING PROOFS FOR MATCHING/DUPLICATING THE REFERENCE

Date:
2026-07-10

Status:
Fixed, deployed. Explicitly authorized: reproduced production bug +
Sana's direct approval, per the QI V1 stability rule (do not modify QI
unless there is a reproduced production bug or explicit approval).

Problem:

A worker's proof photo was rejected as fraud_suspected — "exactly the
same uploaded image as the reference, not a new photo of the completed
task" — with the correction message telling the worker to "upload a new
live proof photo." The correct item (a bowl) was shown; its state
genuinely had not changed. An earlier production test with the
identical pattern (a pepperoni pizza re-uploaded as its own proof) had
been approved.

Root cause:

Commit `765887a` ("Prevent proof duplicate false positives",
2026-07-07) added `hasExactReferenceDuplicate()` — a deterministic
byte-for-byte comparison of the proof's base64 against the reference's
base64 — to `api/_quality-review.js`. When a proof photo was byte-
identical to the reference, `runQualityReview()` short-circuited to
`fraud_suspected` with a hardcoded "exactly the same uploaded image as
the reference" note, *before the Anthropic model was ever called*.
This bypassed every existing safety net (`isUnsupportedReferenceReuseClaim`,
`isStyleOnlyRejectionReason`, etc.) since those only run on model output.
The pizza test predates this commit (went straight to the model, which
approved it); the bowl test postdates it (hit the new deterministic
path and was auto-rejected regardless of outcome correctness).
Separately, the prompt's FRAUD_SUSPECTED definition also explicitly
listed "the exact same reference image re-uploaded... rather than just
forward the reference back" as valid fraud evidence on its own — a
second, independent way the same wrong signal could reach a rejection.

QI V1 product policy (per this fix): approve when the proof matches the
requested outcome; reject only clear wrong outcomes (wrong item). Same
image, similar image, polished/studio/internet-looking, not-live
suspicion, and duplicate-image suspicion must never cause rejection on
their own.

Fix — api/_quality-review.js:

• Removed `hasExactReferenceDuplicate()` and its call site entirely.
  Every proof, including a byte-identical one, now goes to the model.
• Removed "or the proof being the exact same reference image
  re-uploaded... rather than just forward the reference back" from the
  FRAUD_SUSPECTED prompt definition — the model is no longer told this
  is valid evidence.
• Removed the now-false "the system already performs an exact
  byte-for-byte duplicate check" prompt claim; rewrote the identity/
  similarity guidance to state plainly that identical/near-identical
  proofs are a GOOD sign, never suspicious on their own.
• Narrowed `isConcreteNonLiveProofReason()` — dropped "not a new photo"
  and "exactly the same uploaded image" as valid non-live evidence, so
  the existing style-only-rejection safety net can no longer be blocked
  by same-reference wording.
• Closed a related gap: added "internet"/"web image"/"online" to the
  style-only-rejection safety net (`isStyleOnlyRejectionReason`) and to
  the prompt's NEVER-reject-for-this list — "internet-looking" wasn't
  previously caught alongside "stock"/"studio"/"polished".
• Updated the stale note text on the model-claim downgrade path
  (`isUnsupportedReferenceReuseClaim`) from "no deterministic duplicate
  was detected" to "identity or similarity to the reference is not a
  valid reason to reject", since there's no more deterministic check to
  reference.

Deliberately unchanged:

• Screenshot/product-listing/menu/app-UI FRAUD_SUSPECTED detection —
  genuine non-photographic evidence, unrelated to this complaint.
• CORRECTION_REQUIRED for a clearly wrong/mismatched item.
• `isUnsupportedReferenceReuseClaim()` itself — still a useful safety
  net catching the model's own hallucinated "same as reference" claims
  and downgrading them to approved.
• Worker confirmation UI, upload UI (Sana's explicit "do not touch"
  scope from the prior task).
• `task-confirm.js`'s WhatsApp-sending logic and `buildWorkerCorrectionNote()`
  — untouched; the same-reference correction message stops appearing
  only because the classification path that produced it no longer
  exists, not because the WhatsApp template was edited.

Tests added/updated (api/_quality-review.test.js):

• New describe block "production fix (2026-07-10): same-reference/
  duplicate-image/live-proof suspicion is not grounds for rejection"
  with Sana's 4 required regression tests:
  1. Same reference/proof image with a matching requested outcome
     (a bowl) must approve.
  2. A polished/internet-looking matching food proof (a pizza) must
     approve.
  3. A clear wrong food proof (pizza submitted for a salad task) must
     still reject with correction_required.
  4. Existing correction WhatsApp still sends for a clear wrong outcome
     — protected by the pre-existing, untouched
     api/task-confirm.test.js test "correction_required review: keeps
     task pending, creates a message row, and sends WhatsApp through
     direct_message" (mocks runQualityReview directly, so it already
     proves the WhatsApp path is unaffected by this fix).
• Inverted 2 pre-existing tests that had asserted the now-wrong
  deterministic-rejection behavior (one of these was itself a
  "protected behavior" test from the prior c132c32 fix — explicitly
  reversed here per Sana's direct instruction).
• Updated 1 prompt-instruction test's assertions to match the new
  prompt wording (removed "exact byte-for-byte duplicate check" /
  "exact same reference image re-uploaded" claims; added assertions
  for the new identity/similarity guidance).

Commands run:

• npx vitest run api/_quality-review.test.js — 39/39 passed
• npx vitest run api/task-confirm.test.js — 54/54 passed (unaffected —
  confirms WhatsApp/upload/submission logic untouched)
• npm run typecheck — passed
• npm test (full suite) — 1175/1175 passed across 92 files
• npm run build — passed; client JS/CSS bundle hashes unchanged from
  the prior build, confirming this was a pure backend/API change with
  zero frontend impact (only api/_quality-review.js and its test file
  changed)

Commit:
44b18fd — "Stop QI from rejecting proofs for matching/duplicating the
reference"

Not touched:

• Worker confirmation UI, upload UI, WhatsApp template/send logic,
  scheduler/cron, push subscription logic, Clear My Head, Supabase
  auth/RLS, schema.

Remaining risks:

• Live interactive verification with a real task/photo not performed by
  Claude in this environment (no signed-in browser session or live
  Anthropic-backed review call) — recommend Sana manually re-run the
  bowl scenario (same reference/proof image) and confirm it now
  approves, and separately confirm a genuinely wrong-item proof still
  gets correction_required.
• This fix relies more heavily on the model's own judgment (no
  deterministic backstop for exact duplicates) — if a genuinely
  malicious "just re-forward the reference" pattern becomes a real
  problem in practice, that would need a different, outcome-aware
  detection approach, not a reintroduction of the blanket byte-identity
  check this fix removes.

──────────────────────────────

UPDATES MOBILE TAB REACHABILITY FIX

Date:
2026-07-10

Status:
Fixed, deployed. Phase 11 reliability item — Updates mobile tab row not
fully reachable.

Problem:

On iPhone PWA, Updates only visibly showed Needs You / Waiting / To-do
/ Notes. Inbox / Automations / History were not reaching the visible
area. Related, previously-known symptom: "Updates carousel moves once
then stops."

Audit performed first, per instructions:

• Source of truth: Updates.tsx's TABS array (7 tabs: needs-you,
  waiting, todo, inbox="Notes", clear-my-head="Inbox",
  routines="Automations", history) + its chip scroller. Single
  implementation — confirmed no duplicate/parallel/fallback tab-bar via
  repo-wide grep. BottomNav.tsx is a separate, unrelated app-level
  4-tab nav (Home/Updates/People/Carson), not a duplicate of this.
• Horizontal scroll: confirmed present and mechanically functional —
  `overflow-x-auto` with `shrink-0` children; no blocking global CSS
  (`body { overflow-x: hidden }` only guards the page itself and
  doesn't affect this inner scroll container; `touch-action:
  manipulation` explicitly permits panning). Manual swipe already
  worked before this fix.

Root cause:

The chip row's auto-scroll (a slow, looping marquee meant to cycle all
7 tabs into view when idle) self-pauses every frame it moves. Setting
`el.scrollLeft` inside the `tick()` rAF loop fires a native `scroll`
event that is indistinguishable from a user-driven one. The `onScroll`
handler called `pauseChipAutoScroll()` unconditionally on every scroll
event — including ones the auto-scroll caused itself — so it advanced
by a fraction of a pixel, immediately paused itself for the whole
1200ms resume cooldown, then repeated. Over any short observation
window this looks exactly like "moves once then stops," and the
practical effect was that the app's own mechanism for surfacing
off-screen tabs never actually cycled Inbox/Automations/History into
view on a narrow iPhone-width screen.

Fix — src/routes/Updates.tsx:

Added `chipProgrammaticScrollRef`, a guard flag set to `true`
immediately before the auto-scroll's own `el.scrollLeft` mutation.
The scroll handler (renamed `handleChipScroll`) checks this flag first:
if set, it means the scroll event was self-caused, so it clears the
flag and returns without pausing; otherwise it pauses as before. The
`onScroll` handler itself was kept (not removed) because it's the only
path that catches keyboard-driven scroll — the pointer/touch/wheel
handlers don't cover that, and removing it would have been an
accessibility regression. Genuine user-interaction handlers
(onPointerDown, onTouchStart, onWheel, etc.) are unchanged.

Live device testing note: attempted to start the dev server via the
preview tool for interactive/visual verification on a simulated mobile
viewport, but the tool could not locate .claude/launch.json in this
environment despite the file existing and being valid JSON in both the
Desktop working directory and the project directory — likely an
environment/sandboxing limitation, not a config problem. Proceeded with
a thorough static/code-level audit and reasoning-based verification
instead, and disclosed this limitation rather than claiming live
verification that didn't happen.

Tests added (src/routes/Updates.test.ts, 4 new tests):

• All 7 tabs present and doubled for the seamless auto-scroll loop.
• The auto-scroll tick() sets the programmatic-scroll guard immediately
  before mutating scrollLeft.
• onScroll is routed through handleChipScroll, which skips pausing for
  self-caused events and still pauses for genuine ones.
• Genuine user-interaction handlers (pointer/touch/wheel) still pause
  directly, unaffected by the guard.

Commands run:

• npx vitest run src/routes/Updates.test.ts — 8/8 passed
• npm run typecheck — passed
• npm test (full suite) — 1179/1179 passed across 92 files
• npm run build — passed (only pre-existing routine:* CSS and
  bundle-size warnings)

Commit:
a54db87 — "Fix Updates chip row auto-scroll self-pausing so all tabs
stay reachable"

Deployment:
dpl_GgXK7niTZUi2t3e5axngJB9ho5r8 — READY, aliased to production
(ra7etbal-v2.vercel.app, ra7etbal.com/www.ra7etbal.com).

Not touched:

• Updates data logic (buildDailyBrief, task fetching), task state
  logic, notifications, QI, Clear My Head, WhatsApp, schema, auth/RLS.

Remaining risks:

• No live device/browser verification performed in this environment
  (preview tool could not locate launch.json — see note above).
  Recommend Sana manually confirm on iPhone PWA that the chip row now
  visibly auto-cycles through all 7 tabs when idle, and that manual
  swipe still reaches Inbox/Automations/History directly.
• The fix only changes *when* the auto-scroll pauses, not its speed or
  loop mechanics — if the row still feels too slow to reach the later
  tabs in practice, that would be a separate, subsequent tuning task.

──────────────────────────────

PRODUCTION VERIFICATION FAILED: STICKY CTA FALSE POSITIVE + UPDATES
CAROUSEL RE-AUDIT

Date:
2026-07-10

Status:
Fixed, deployed. Sana's manual verification of the two prior fixes
above found the Updates carousel fix insufficient and a new regression
in the sticky CTA fix. Not claiming the Updates carousel item closed.

── A. Clear My Head sticky CTA regression ──────────────────────────

Observed: the sticky CTA appeared on Home even with the keyboard
closed, floating over the page near the stats section.

Root cause: `keyboardOpen` was `textareaFocused || viewportShrunk`.
`viewportShrunk` is a visualViewport-derived heuristic
(computeKeyboardInset() > 120) that has been observed to read true on
iOS PWA with no real keyboard involved — a known category of iOS
standalone-PWA visualViewport quirks (window.innerHeight and
visualViewport.height/offsetTop have been reported to disagree
persistently in standalone display mode on some iOS versions). Since
`viewportShrunk` alone (OR'd with textareaFocused) was sufficient to
open the CTA, a misread with the textarea never focused was enough —
and the CTA then positioned itself using the same (also heuristic)
`keyboardInset` value, landing wherever that number placed it rather
than near the bottom.

`viewportShrunk` itself predates this session by a large margin (git
blame: commit dd922df, "Home: float Next button above iOS keyboard +
Safari URL bar"). The earlier CTA-positioning fix in this session did
not change *when* viewportShrunk misreads — it changed the CTA from a
small fixed 132px offset (quiet, easy to miss if triggered by mistake)
to a large dynamically-computed offset, which is what made a
pre-existing quiet false positive suddenly land somewhere
objectionable (near the stats section) instead of near the bottom.

Fix — src/routes/Home.tsx:

Added `recentlyFocused` state, true while the textarea is focused and
for a 600ms grace window after blur (to avoid the CTA vanishing mid
focus→blur→keyboard-closing transitions, e.g. tapping attach-photo).
`keyboardOpen` is now `textareaFocused || (recentlyFocused &&
viewportShrunk)` — viewportShrunk can never open the CTA on its own
without a real focus event having happened, regardless of what causes
it to misread. New `handleTextareaFocus`/`handleTextareaBlur` handlers
wired to the textarea's onFocus/onBlur replace the raw inline setters.

── B. Updates carousel — deeper re-audit ────────────────────────────

Observed: after the self-pause fix (previous entry), the carousel
still did not visibly auto-cycle on iPhone PWA — only Needs You /
Waiting / To-do / Notes reachable without touching the row.

Re-audited every candidate per the instructions:

• Scroll container / duplicated tabs / max scroll: re-confirmed sound
  (unchanged from the prior audit) — not the cause.
• Selected-tab reset: the auto-scroll effect has an empty dependency
  array (mount-only); nothing resets scrollLeft on re-render or tab
  change.
• Animation speed: the inherited 0.03px/ms (0.6px/20ms) speed meant a
  realistic ~800px loop width (7 tabs' worth of chips) took ~25-30
  real seconds for one full cycle. Even with the self-pause bug fixed,
  a few seconds of observation would show only ~100-150px of movement
  — very plausibly imperceptible as "moving" rather than static noise.
  This is very likely the dominant remaining cause. Raised to
  0.09px/ms (~90px/s), a full loop in well under 10 seconds.
• prefers-reduced-motion: re-verified the check itself character by
  character — it correctly reads the OS accessibility setting via
  `matchMedia("(prefers-reduced-motion: reduce)")` with a live change
  listener (not just a one-time mount read), no inverted logic found.
  If reduced motion is enabled on the test device, the marquee is
  *intentionally* disabled per the original Phase 11 spec ("respect
  reduced-motion") — that is correct, accessibility-compliant
  behavior, not a bug, and reachability for those users is served by
  manual swipe (already confirmed working). Flagged explicitly rather
  than silently assumed either way — recommend Sana check iOS
  Settings > Accessibility > Motion > Reduce Motion if the carousel
  still doesn't move after this deploy.

Fix — extracted testable logic instead of trusting source-scan tests
alone (per instruction "do not rely only on source-scan tests"):

New src/lib/chip-auto-scroll.ts — pure, DOM-free functions:
• `advanceChipScrollLeft(scrollLeft, scrollWidth, dtMs, pixelsPerMs)` —
  the advance/wrap math.
• `shouldAdvanceChipAutoScroll({ hidden, reducedMotion, paused })` —
  the gating logic.

Updates.tsx's tick() now calls these instead of inlining the math, and
the speed constant was raised to 0.09.

Tests added:

• src/lib/chip-auto-scroll.test.ts (new, 11 tests) — real behavioral
  tests: proportional advancement, exact loop-boundary wraparound,
  no-op when scrollWidth is 0, frame-accumulation consistency (many
  small frames sum to the same distance as one large frame), a full
  loop completes within 10 real seconds at the new speed, and each
  gate (hidden/reducedMotion/paused) individually and combined blocks
  movement.
• src/routes/Home.test.ts (+4 tests) — keyboardOpen requires
  textareaFocused or (recentlyFocused && viewportShrunk), never
  viewportShrunk alone; handleTextareaFocus sets both flags;
  handleTextareaBlur clears textareaFocused immediately but
  recentlyFocused only after the 600ms grace timeout; textarea wired
  to the new handlers, not raw setters.
• src/routes/Updates.test.ts (+4 tests, 1 updated) — Updates.tsx wires
  in the tested pure functions (not inline math); all three gates
  (hidden/reducedMotion/paused) are passed through, none dropped;
  speed constant raised from the old value; reduced-motion still
  re-evaluated live via a change listener.

Commands run:

• npx vitest run src/routes/Updates.test.ts src/lib/chip-auto-scroll.test.ts
  src/routes/Home.test.ts — 36/36 passed
• npm run typecheck — passed
• npm test (full suite) — 1198/1198 passed across 93 files
• npm run build — passed (only pre-existing routine:* CSS and
  bundle-size warnings)

Commit:
9963b19 — "Fix sticky CTA false-positive and re-audit Updates carousel
visibility"

Not touched:

• Clear My Head routing, QI, WhatsApp, task state logic, Updates data
  logic, notifications, schema, auth/RLS.

Remaining risks:

• No live device verification performed in this environment (same
  preview-tool limitation as the prior entry) — this is now the third
  attempt at the Updates carousel item without a real device in the
  loop; recommend Sana re-verify on the actual iPhone PWA before this
  is considered closed.
• If the carousel still doesn't move after this deploy, the most
  likely remaining explanation is OS-level Reduce Motion being enabled
  on the test device (see prefers-reduced-motion note above) — that
  would be correct behavior per the original spec, not a bug, and
  would need a product decision (e.g., a manual "jump to more tabs"
  affordance) rather than another code fix to the auto-scroll itself.
• The sticky-CTA fix assumes viewportShrunk's false-positive is
  transient/environmental rather than a permanent stuck-true state —
  if visualViewport genuinely never settles back down on some device,
  the 600ms grace window bounds the worst case but does not diagnose
  the underlying iOS viewport-reporting quirk itself.
