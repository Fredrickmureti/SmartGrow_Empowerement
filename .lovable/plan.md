# Consolidation — status after R5

## R5 — COMPLETE (verified against the live database)

The consolidation residual was not a group problem. The parent carried a
USD 20,000 intragroup receivable at the trade rate 131.5 while the closing rate
on 2026-08-31 was 129.5. Under IAS 21.45 that KES 40,000 is the parent's own
exchange difference.

What was done, and the evidence:

1. `4945 FX Unrealized Gain` and `6925 FX Unrealized Loss` created in the
   parent's chart through `upsert_system_account`, and mapped in Default
   Accounts as `fx_unrealized_gain` / `fx_unrealized_loss`. The resolver no
   longer falls back onto the *realized* accounts.
2. Three engine defects fixed, each of which would have made the revaluation
   wrong or impossible:
   - a posted journal could not be filed into its journal book, so no
     non-empty FX revaluation could ever post (`enforce_journal_entry_immutability`
     now allows a one-time book stamp, and a no-op update, and nothing else);
   - `fx_open_monetary_positions` ignored the base-currency adjustment a prior
     revaluation had already posted, so the same difference would be recognised
     again on every run — recognised amounts are now netted off;
   - exposure was measured per account only, so an adjustment never reached the
     counterparty balance the consolidation engine compares. Exposure is now
     measured per counterparty, the revaluation tags its adjustment with that
     counterparty, and a reversal mirrors it.
3. Revaluation posted for the parent at 2026-08-31 through the existing
   `revalue_fx_balances`: **Dr 6925 40,000 / Cr 1180 40,000**, receivable now
   KES 2,590,000 against the subsidiary's KES 2,590,000 payable.
4. Result: the intercompany balance gap fell from **41,500 → 1,500 KES**, and
   `fx_unrecognised_exchange_difference` now returns nothing for either member.
   The fitted tolerances had already been reset to 100 with a recorded reason.
5. The diagnosis is now machine-readable rather than prose: a new
   `unrecognised_member_fx` cause with a `run_member_fx_revaluation` remedy that
   links to the member's own revaluation screen, plus an architecture test that
   this remedy can never be applied as a group policy change.

## What the remaining refusal is

Eliminations still refuse, and correctly so — both remaining gaps are
translation residuals, not member errors:

- intercompany_balance **1,500 KES**
- intercompany_trading **38,500 KES**

Deciding where those may go is **R4**, not R5: a trading residual is unrecorded
profit or a cut-off difference and must never reach the translation reserve.

## R4 — COMPLETE (verified against the live database)

- `difference_policy` is consulted inside tolerance too, so a `refuse` group
  refuses a small gap rather than absorbing it silently.
- Trading-class residuals can never reach the translation reserve — refused
  both by the engine and by the rule guard, so the policy cannot even be saved.
- A gap the members have not recognised is refused from the reserve as well;
  the diagnosis names the member, amount, carried rate and closing rate.
- Tolerances are bounded by `consolidation_tolerance_cap()`, require a written
  reason above zero, and record changed-by/at plus a group change-log row. This
  tenant's fitted 41,500 / 1,500 are reset to 100 with a recorded reason.
- Any residual the policy does let through is now disclosed by name on the face
  of the consolidated statements: `get_consolidated_statement_lines_eliminated`
  returns `reconciling_amount` footed off the difference legs, and the line
  reads "includes an unreconciled intragroup difference of X". Guard test added.

## Remaining order

- **R2b** — artifacts stop printing a per-render hash under the word "Run".
- **R6** — opening + movement = closing for the translation reserve; move the
  group reserve off the parent's account 3050 onto a group-chart account.
- **R7** — revoke `anon` EXECUTE on the run-lifecycle RPCs; drive one real
  create → finalize → supersede.
- **Final artifact acceptance gate** across every consolidation surface.
