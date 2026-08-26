# Consolidation — verification verdict and Brick 3 scope

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already
connected to this project; no connection work is needed.

## Phase 1 — what I verified directly (not taken from the previous notes)

Checked against the live database and the actual files, not the handover claims.

Confirmed true:
- `resolve_consolidation_scope(_group_id, _as_of)` exists, SECURITY INVOKER.
- `consolidation_scope_member_count(_group_id, _as_of)` exists, SECURITY DEFINER
  (the single definer piece, as documented).
- `get_consolidated_trial_balance(_group_id, _date_from, _date_to)` exists,
  SECURITY INVOKER.
- `get_gl_pnl_totals(_org_id, _date_from, _date_to, _business_id, _branch_id)`
  exists, SECURITY INVOKER, and `src/services/gl/fetchGLTotals.ts` is a thin RPC
  wrapper.
- Tables `consolidation_groups` (with `presentation_currency`, `parent_business_id`),
  `consolidation_group_members` (ownership, method, effective dating) and
  `consolidation_group_change_log` exist.
- UI exists: `ConsolidationGroupsSettings`, `ConsolidatedTrialBalance` page and route,
  `Consolidation` comparative page, plus the three architecture test files.
- The underlying ledger engine (`get_account_movements`,
  `get_ledger_opening_balances`) is the only source the consolidation RPCs read —
  no second accounting engine was introduced.

Confirmed still open (the previous notes were honest here):
- **Nothing has ever been exercised on real data.** The database holds 0
  consolidation groups, 0 members, 2 businesses, and only 37 journal entry lines,
  all in a single currency. Brick 2 is structurally complete but has never produced
  a number that anyone reconciled.
- The two SQL invariant suites (`consolidation_group_foundation_test.sql`,
  `consolidated_trial_balance_test.sql`) have never been executed.

Correction to the previous framing: Brick 2 should be treated as **built but
unvalidated**, not "Done". No Brick 3 work starts until it is validated.

## Phase 2 — items I am adding to the plan

1. **Validation is a first-class brick, not a footnote.** Brick 2V below.
2. **Average and historical rates do not exist anywhere yet.** The platform has one
   authoritative resolver, `resolve_exchange_rate(org, business, currency, date)`,
   which answers a spot rate for one date. IAS 21 also needs a period average rate
   and per-transaction historical rates. These must be added *inside* the existing FX
   engine, not as a competing resolver, and must refuse when rate coverage for the
   period is too thin to compute an honest average.
3. **CTA needs a real account, not a plug in a report.** The group configuration must
   name the equity account that carries the cumulative translation adjustment, and
   the reconciliation (opening CTA + movement = closing CTA) must be shown.
4. **Monetary/non-monetary classification already exists** (`fx_is_monetary_account`)
   and must be reused for rate selection rather than re-derived.

## Brick 2V — validate the existing foundation (next work, in order)

- Execute both SQL invariant suites against the connected database and fix whatever
  they surface.
- Create a real consolidation group: two same-currency members, ownership recorded,
  posted journal entries in each.
- Reconcile: consolidated trial balance must equal the arithmetic sum of each member's
  own trial balance, and debits must equal credits.
- Confirm `get_gl_pnl_totals` returns figures identical to the P&L statement for the
  same period and scope (no dashboard drift from the Brick 2b refactor).
- Confirm the refusal paths actually refuse: a member the caller cannot see, a mixed
  currency member, an equity-method member, an inverted date range.
- Record the results in this file. Only then start Brick 3.

## Brick 3 — FX translation and CTA (scope, after 2V signs off)

Database:
- Extend the FX engine with `fx_period_average_rate(org, business, currency, from, to)`
  built from the existing `exchange_rates` data, refusing when coverage is insufficient.
- `consolidation_translate_member(group, member, from, to)` — SECURITY INVOKER,
  reusing `get_ledger_opening_balances` / `get_account_movements` and
  `resolve_exchange_rate`: closing rate for assets and liabilities, period average for
  income and expenses, historical (transaction-date) rate for equity and pre-existing
  reserves.
- Derive CTA as the residual that restores the balance, post it to the group's
  designated CTA equity account, and expose an opening/movement/closing CTA
  reconciliation so the number is explainable.
- Remove the `currency_translation_required` blocker only once translation actually
  works; add narrower blockers (missing rate coverage, missing CTA account).

Configuration:
- Add CTA equity account and translation basis to the consolidation group settings UI.

Reporting:
- Consolidated trial balance gains a presentation-currency column set, per-member
  translated figures, the rate used per rate class, and the CTA line.

Client rule: zero FX arithmetic in TypeScript. The browser displays what the database
computed.

Tests: same-currency group (translation must be a no-op), parent KES / subsidiary USD,
rate-coverage gap refusal, CTA reconciliation, closed-period behaviour.

Explicitly out of scope for Brick 3: intercompany identification, eliminations,
consolidated cash flow, persisted consolidation runs, minority interest measurement
beyond the existing disclosure.



===============IMPLEMENTATION PROGRESS STATUS===============
Work paused mid-Brick 3. Here is exactly where things stand.

Applied to the database (live now):

consolidation_groups.cta_account_id and consolidation_group_members.historical_rate_date — additive, nullable, so nothing existing breaks.
_consolidation_cta_account_guard + trigger: a CTA account must exist, belong to the group's organisation and its parent company, be an equity account, be postable and active.
FX engine extension, inside the existing rate store rather than beside it: fx_rate_on (rate between two stated currencies, reusing _pick_exchange_rate_row), fx_period_average_rate (daily average, returns NULL rather than a partial average when any day of the period has no rate on file), and _consolidation_fy_start.
consolidation_member_translation_rates — resolves closing, opening, period-average, prior-year-part-average and historical rates for one member.
Not yet applied (written and reviewed, but the run was cut off): consolidation_translate_member (closing rate for assets/liabilities, historical for equity, average for P&L, CTA as the balancing residual), the revised resolve_consolidation_scope (currency difference becomes requires_translation rather than a dead-end blocker, with a new cta_account_not_configured blocker), the guard in get_consolidated_trial_balance that keeps the untranslated report refusing mixed-currency groups, get_consolidated_trial_balance_translated, consolidation_cta_reconciliation, and the EXECUTE grants that keep all of it away from anon.

Also still pending: the migration file for the repo, the settings UI for the CTA account, the presentation-currency columns on the report, the translated-path tests, and the plan update.

Important: the database is currently in a half-built state — the new rate functions exist but nothing consumes them, and resolve_consolidation_scope still reports currency_translation_required as a hard blocker. That is safe (no behaviour has changed for users; the untranslated report works exactly as before and still refuses mixed currency), but Brick 3 is not coherent until the remaining functions land. The next agent should re-apply the remaining SQL as one unit before touching any UI, then verify with a parent-KES / subsidiary-USD fixture that opening CTA + movement = closing CTA and that the translated trial balance balances.