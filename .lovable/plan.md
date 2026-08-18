# Finance Settings: fix the false "read-only / no permission" walls

## What you are seeing, and why it is wrong

Your tenant is correctly set up. I checked the live database:

- One organization, one company, one branch (the auto-created HQ).
- Your account (`devmuret@gmail.com`) holds the active `owner` role.
- The server function that decides finance rights, `has_finance_permission`, grants
  **every** `finance.*` permission to `super_admin / owner / admin / accountant`.
  So the database would happily accept every write those banners claim it will reject.
- The read-only branch banner (`BranchReadOnlyBanner`) correctly stays hidden for a
  single-branch company — that one is behaving.

So the red messages are not a real permission problem. They are a UI defect with three
distinct causes:

1. **Deny-by-default while loading.** `useFinancePermission` starts at `allowed = false`
   and asks the server on every mount. `FinanceAccountingControls` renders its red
   "Read-only — finance.manage_settings required" banners from `allowed` alone, ignoring
   the loading flag — so the wall is painted on every page load before the answer arrives.
   `LockDatesCard` and `DefaultAccountsConfig` do wait for loading, but they still flash
   whenever the company context resolves after them.
2. **No company = denied.** The hook returns `false` (not "unknown") whenever
   `currentBusiness` is still null. The company is loaded asynchronously from
   `user_business_access` + `user_active_business`, so during that window every finance
   gate on the page reads "you lack permission", and the separate
   "Select a Company first — default account mappings are per-company" alert renders too,
   even though a company exists and is about to be selected.
3. **Developer language in a customer-facing surface.** Raw permission codes
   (`finance.manage_periods`), "The DB will reject writes even if the form is bypassed",
   and destructive red styling for what is usually just an informational state.

There are 18 call sites of this hook, each firing its own uncached RPC, so a single
Finance page can issue 3–5 identical permission round-trips.

## How mature platforms handle this

- **Odoo**: access rights are resolved server-side and shipped with the record/action
  payload; the client never guesses. A user without rights simply does not get the button
  — no red banner. Warnings are reserved for the multi-company case ("this record belongs
  to another company").
- **NetSuite / Xero / QuickBooks**: permissions are hydrated once per session into a
  permission map. Un-permitted controls are hidden or disabled with a quiet tooltip, and
  never phrased as an error. QuickBooks single-location files never show any
  location/branch scoping chrome at all — the chrome appears only once a second location
  exists.
- **Universal rule**: three states, not two — `loading`, `allowed`, `denied`. Loading
  renders skeletons, never a denial. And single-entity tenants see zero multi-entity
  scaffolding.

## What we will change

### 1. Make the permission gate tri-state and cached
Rewrite `src/hooks/finance/useFinancePermission.ts` on React Query:
- Return `{ allowed, isLoading, isReady }` where `isLoading` is true while the user, the
  company, or the RPC is unresolved.
- Cache by `(user, business, perm)` with a long `staleTime`, and add a
  `useFinancePermissions([...])` batch variant so one page makes one round-trip.
- Never resolve to `denied` because the company hasn't loaded — that stays `loading`.

### 2. No denial UI until the answer is known
- `FinanceAccountingControls`: gate all three read-only alerts (journals, reconciliation,
  FX) on `!isLoading`, and disable inputs while loading rather than showing a banner.
- `LockDatesCard`, `DefaultAccountsConfig`: same treatment, so the card renders its normal
  skeleton instead of a red wall.
- `FinanceSettings`: show the "Select a Company first" alert only after the company
  context finished loading and genuinely has no company; while loading, render the
  existing page skeleton.

### 3. Rewrite the messages for humans
Replace destructive red alerts with a neutral, informational style (muted/amber, lock
icon) and plain wording, e.g.
"You can view these settings. Editing finance settings is limited to owners, admins and
accountants — ask an admin to make changes."
Raw permission codes move to a `title` tooltip for support, out of the visible copy. Same
pass over the lock-dates and fiscal-period banners.

### 4. Hide single-branch scaffolding
Confirm every finance surface that mentions branches/HQ short-circuits when the company
has one branch (`hasMultipleBranches === false`). `BranchReadOnlyBanner` already does;
we audit the fiscal-period and reports scope labels for the same rule so an HQ-only
tenant never reads about branch scoping.

### 5. Lock the behaviour in
Add an architecture test asserting no finance component renders a denial alert from
`allowed` without also checking the loading flag, so this cannot regress.

## Technical notes

- No database change is needed. `has_finance_permission` is already correct and already
  grants owner/admin/accountant every finance permission; `EXECUTE` is granted to
  `authenticated`. The fix is entirely client-side presentation and caching.
- Existing tests referencing `useFinancePermission("finance.manage_periods")` string
  patterns (`src/test/architecture/*`) keep passing — the call signature is unchanged,
  only the returned shape gains `isReady`.

## Out of scope

- Introducing a granular per-permission role editor (today's role→permission mapping is
  coarse but intentional). If you want finance permissions assignable per user via
  permission groups, that is a separate wave.
