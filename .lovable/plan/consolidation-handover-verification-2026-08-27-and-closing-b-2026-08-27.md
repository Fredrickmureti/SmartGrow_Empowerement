# Consolidation — handover verification (2026-08-27) and closing Brick 3

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already
connected; no connection work is needed.

Everything below was re-checked directly against the live database and the files in
this session. The previous engineer's progress notes were treated as unverified.

## Phase 1 — verification of the previous engineer's claims

| Claim | Verdict | Evidence |
|---|---|---|
| Brick 1: no second accounting engine | True | The consolidation functions read only the authoritative ledger primitives; the comparative page holds no arithmetic |
| Brick 2/3 database objects exist | True | `consolidation_translate_member`, `get_consolidated_trial_balance_translated`, `consolidation_cta_reconciliation`, `consolidation_member_translation_rates` all present; only the member-count helper is SECURITY DEFINER, the rest are INVOKER so RLS still applies |
| Step B accounting corrections landed | True in the database | The translation function classes accounts as closing / average / transaction / historical, and the reconciliation function recomputes the expected reserve movement independently rather than restating the residual |
| Step E: translation test suite written | Partly | `supabase/tests/consolidation_translation_test.sql` exists and is genuinely discriminating (it aborts if the fixture rates are not distinct), but it has not been executed in this session and the earlier suites have not been re-run against the current function bodies |
| Step C: configuration surface done | **False — half landed** | `useConsolidationGroups` reads and writes the reserve account and per-member historical rate date, but `ConsolidationGroupsSettings` only has the imports wired: there is no reserve-account selector and no historical-rate-date control. A mixed-currency group can still be created that is permanently blocked with no way for a user to fix it |
| Step D: reporting surface | **False — not started** | `ConsolidatedTrialBalance` still calls only the untranslated RPC and still tells the user "no FX translation / CTA"; nothing in the app consumes the translated RPC |

Typecheck is currently clean, so the half-finished state is silent — which is exactly
the failure mode worth guarding against.

**Conclusion:** the database side of Brick 3 is real and defensible. Brick 3 is *not*
closed, because a capability the product does not expose is not a delivered capability.
Resume at Step C.

## Phase 2 — additions to the plan

- Re-run all four SQL suites against the current function bodies before building UI.
  A test written but never executed is not evidence.
- Add an architecture test that fails when a consolidation RPC exists with no consumer
  in `src/`, mirroring the existing consolidated-trial-balance architecture test. This
  class of half-landed work must break the build, not sit quietly.
- The reserve-account picker must mirror the database guard exactly (active, postable
  equity accounts of the parent company) so the UI cannot offer a choice the database
  will reject.

## Work order

### Step A — re-validate (blocking)
Execute `consolidation_group_foundation_test.sql`,
`consolidated_trial_balance_test.sql`,
`consolidated_trial_balance_reconciliation_test.sql` and
`consolidation_translation_test.sql` against the live functions. Fix whatever they
surface. Record the results in this file. Nothing else starts until they pass.

### Step B — finish the configuration surface
- Translation-settings card in `ConsolidationGroupsSettings`: reserve (CTA) equity
  account selector, restricted to the parent company's active postable equity
  accounts, with an explicit warning when a mixed-currency group has none.
- Per-member historical rate date control, shown only for members whose base currency
  differs from the group's presentation currency.
- Refuse saving a mixed-currency group with no reserve account, stating the reason.

### Step C — reporting surface
- `ConsolidatedTrialBalance` switches to the translated RPC when the group is mixed
  currency: presentation-currency columns, per-line rate class and rate applied,
  per-member translated figures, and the translation-reserve line.
- Reconciliation panel driven by `consolidation_cta_reconciliation`, showing the
  residual, the independently computed expectation, the difference and the pass/fail
  flag.
- Remove the stale "no FX translation / CTA" copy.
- Zero FX arithmetic in TypeScript — the browser renders what the database computed.
- Refusal reasons (missing rate coverage, missing reserve account, inaccessible member,
  equity-method member) are surfaced as explanations, never as a blank report.

### Step D — tests and checkpoint
- Same-currency group: translation is a no-op and totals are unchanged.
- Rate-coverage gap and missing-reserve-account refusals.
- The architecture test that every consolidation RPC has a consumer.
- Then write the Brick 3 stop/go checkpoint into this file: what was established,
  what accounting rules now hold, what security boundaries exist, what passed, and
  what Brick 4 depends on.

## Explicitly out of scope until Brick 3 closes

Intercompany identification, eliminations, consolidated cash flow, persisted
consolidation runs, minority interest, equity method. No placeholders for any of them.
