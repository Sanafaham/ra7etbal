# Ra7etBal v2 — Regression Checklist

Every step of the rebuild ends here. **A step is NOT complete until every related item below has been manually verified on all three targets:**

- **D-Chrome** = desktop Chrome (latest)
- **D-Safari** = desktop Safari (latest, macOS)
- **iOS-Safari** = iPhone Safari (real device or simulator, latest iOS)

Mark each box on each target. Do not move to the next step while anything is red.

---

## Step 1 — Scaffold + deploy preview

- [ ] Local `npm run build` succeeds with no warnings
- [ ] Local `npm run dev` serves the shell
- [ ] Vercel preview URL loads the shell
- [ ] `/api/health` (or equivalent placeholder) returns 200 on preview
- [ ] SPA fallback works: visiting `/anything` on preview serves the app (not a 404)
- [ ] No console errors on preview (D-Chrome, D-Safari, iOS-Safari)

## Step 2 — Supabase client + session machine

- [ ] Supabase client instantiated exactly once (verify in devtools)
- [ ] Auth state listener registered before first `getSession()` call
- [ ] Status visible on debug page: `loading | signed_out | signed_in | recovery`
- [ ] No duplicate listeners after hot reload

## Step 3 — Auth screens

| Item | D-Chrome | D-Safari | iOS-Safari |
|---|---|---|---|
| Sign up with new email | [ ] | [ ] | [ ] |
| Sign up with existing email shows clear error | [ ] | [ ] | [ ] |
| Sign in with correct password | [ ] | [ ] | [ ] |
| Sign in with wrong password shows clear error | [ ] | [ ] | [ ] |
| Sign in with unknown email shows clear error | [ ] | [ ] | [ ] |
| Password eye toggle reveals/hides | [ ] | [ ] | [ ] |
| Double-click submit is blocked | [ ] | [ ] | [ ] |
| Network error shows clear error (offline test) | [ ] | [ ] | [ ] |
| Sign out returns to sign-in screen | [ ] | [ ] | [ ] |
| Refresh while signed in stays signed in | [ ] | [ ] | [ ] |
| Reopen app while signed in stays signed in | [ ] | [ ] | [ ] |
| No silent return to sign-in during 5-min idle | [ ] | [ ] | [ ] |
| No duplicate auth listeners (multi-tab) | [ ] | [ ] | n/a |

## Step 4 — Reset password flow

- [ ] "Forgot password?" with empty email shows "Please enter your email first."
- [ ] "Forgot password?" with valid email shows "Reset email sent."
- [ ] Email arrives with reset link
- [ ] Clicking reset link opens the Reset screen (D-Chrome, D-Safari, iOS-Safari)
- [ ] Reset screen rejects passwords < 6 chars with clear error
- [ ] Successful password update shows "Password updated. You can now sign in."
- [ ] After update, user is signed out and on the sign-in screen
- [ ] **Sign in with new password works**
- [ ] **After signing in fresh, Clear My Head → Review does NOT bounce to reset** (the historical bug)
- [ ] **Refreshing the app does NOT bounce to reset**
- [ ] Recovery mode flag is cleared after successful update (verify in store)

## Step 5 — People

| Item | D-Chrome | D-Safari | iOS-Safari |
|---|---|---|---|
| Add a person | [ ] | [ ] | [ ] |
| Edit a person | [ ] | [ ] | [ ] |
| Delete a person | [ ] | [ ] | [ ] |
| Refresh and verify people persist | [ ] | [ ] | [ ] |
| People do not disappear after Clear My Head save | [ ] | [ ] | [ ] |
| People do not disappear after sign-out + sign-in | [ ] | [ ] | [ ] |
| Two users see only their own people | [ ] | [ ] | [ ] |

## Step 6 — Home / Clear My Head

- [ ] Text input accepts long text
- [ ] Character count updates
- [ ] Voice toggle records and transcribes
- [ ] Brief date displays correctly
- [ ] Recent items render

## Step 7 — AI extraction

- [ ] "Tell Christopher to prepare dinner" → **delegation** assigned to Christopher
- [ ] "Tell Christopher dinner is at 9" → **message-only** to Christopher
- [ ] "Ask Ghulam to get the car ready" → **delegation** to Ghulam
- [ ] "Tell Grace I'll be late" → **message-only** to Grace
- [ ] Unknown person creates needs-person flag, not a crash
- [ ] Invalid AI JSON surfaces an error toast, not silent failure
- [ ] Slow AI response shows loading state, no stuck spinner

## Step 8 — Review screen

| Item | D-Chrome | D-Safari | iOS-Safari |
|---|---|---|---|
| All extracted items render | [ ] | [ ] | [ ] |
| Assign dropdown lists all people + Me | [ ] | [ ] | [ ] |
| Changing assignment persists into save | [ ] | [ ] | [ ] |
| **Sticky bottom bar does NOT cover last card** | [ ] | [ ] | [ ] |
| Bottom bar respects iOS safe-area-inset | n/a | n/a | [ ] |
| Back button returns to Home without losing data | [ ] | [ ] | [ ] |

## Step 9 — Save tasks/messages

- [ ] Save updates UI immediately (no manual refresh)
- [ ] Save failure shows clear error and does not lose form data
- [ ] No infinite loading state if Supabase errors
- [ ] Refresh after save shows items still there

## Step 10 — Actions / Messages / Follow-ups tabs

- [ ] Actions tab shows delegated tasks with status + assignee
- [ ] Messages tab shows informational messages
- [ ] Follow-ups tab shows outstanding delegated tasks
- [ ] Filters work (status, assignee)
- [ ] Mark-done updates UI immediately

## Step 11 — Confirmation links

- [ ] Delegated task creates a confirmation URL
- [ ] Opening the link as recipient shows task description + Confirm button
- [ ] Clicking Confirm marks task done
- [ ] Already-confirmed link shows graceful "already done" state
- [ ] **Realtime: host sees follow-up disappear within ~2s of confirmation** (no refresh needed)
- [ ] Realtime works on iOS Safari

## Step 12 — Clear Data

- [ ] Removes current user's tasks + messages from Supabase
- [ ] Preserves People
- [ ] UI clears immediately
- [ ] No stale cache restoration after refresh

## Cross-cutting — session + state

- [ ] Refresh stays logged in (all 3 targets)
- [ ] Reopening browser stays logged in (all 3 targets)
- [ ] No `window.location.reload()` calls anywhere in source (`git grep` check)
- [ ] No `window.location.href =` calls anywhere in source
- [ ] No localStorage reads/writes of Supabase data (only UI prefs allowed)
- [ ] Multi-tab: signing out in tab A signs out tab B within ~1s
- [ ] Multi-tab: signing in in tab A does not loop tab B

## Final regression — before production cutover

- [ ] Every box above is checked on all three targets
- [ ] No console errors on any screen on any target
- [ ] Vercel preview has been live and untouched for 24h, then a fresh visitor flow runs clean
