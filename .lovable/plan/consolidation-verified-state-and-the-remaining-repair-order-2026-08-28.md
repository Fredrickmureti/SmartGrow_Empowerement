# Consolidation — verified state and the remaining repair order

Note on the first request: this project is already connected to the Supabase
project `jkszmrroyjfdwokbkzis`. No new connection step is needed; all work below
runs against that backend.

## Verification of the previous engineer's claims (done this session)

Everything below was re-checked directly against the code and the live database.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| R1 — TB proves on closing balances | Verified | `proveTrialBalanceOnClosingBalances` in `useConsolidatedTrialBalance.ts`, consumed by the TB page; movement columns kept and labelled as not the proof; architecture test asserts it |
| R1 — BS totals/verdict read the eliminated projection | Verified | `get_consolidated_statement_totals_eliminated` migration + `useEliminatedStatementTotals`, wired into `ConsolidatedStatements.tsx` |
| R2 — group masthead identity | Verified | both pages export `reportingEntityBusinessId: parent_business_id`, `branchId: null` |
| R2 — account code/name preserved in exports | Verified | contribution rows now export real code and name |
| R2 — "Run" label truthful | **Not done** | the PDF footer still prints a generic per-render hash (`computeRunHash`) for every report; nothing links to `consolidation_runs` and nothing labels it an export reference |
| R3 — consolidation reports registered with pinned profiles | Verified | four keys in `_shared/reports/columnSpecs.ts`; the registry coverage test iterates `REPORT_SPECS` so they are covered generically |
| R4–R7 | Open | live DB confirms: both elimination rules still carry the fitted tolerances 41,500.00 and 1,500.00 with `difference_policy = refuse`; the group CTA account is still `3050 Foreign Currency Translation Reserve` owned by the member *Joshua Holdings*, not a group account; `consolidation_runs` and `consolidation_run_lines` are both empty; `anon` still holds EXECUTE on `consolidation_create_run`, `consolidation_finalize_run`, `consolidation_supersede_run` and several other consolidation RPCs |

No claimed-complete item was found to be superficial except the R2 run-label
sub-item, which is now folded into the work below as R2b.

## Remaining work, in dependency order

Each step lands complete — SQL, guard, surface, artifact, scenario test, brick
log entry — before the next begins. Each ends with an artifact checkpoint: an
actual regenerated PDF/Excel inspected page by page, not inferred from template
code.

**R2b — Artifact identity truthfulness.** Consolidation artifacts stop printing
a per-render hash under the word "Run". When the report is generated from a
persisted consolidation run, print that run's id and version; otherwise print
`Export reference`. Test asserts a consolidated artifact can never label an
export hash as a run.

**R4 — Make the residual policy honest.** `difference_policy` is consulted
inside tolerance as well as outside, so a `refuse` group actually refuses.
Trading-class residuals are forbidden from reaching the translation reserve —
an intragroup trading mismatch is unrecorded, unrealised profit, or a cut-off
difference, never a translation difference. Any surviving residual is disclosed
as a named reconciling line on the face of the consolidated statements instead
of being buried in equity. Tolerances get an upper bound plus a recorded
changed-by/reason, and this tenant's fitted 41,500 / 1,500 are reset to a
defensible policy value.

**R5 — Remove the cause, not the symptom.** Member-level period-end revaluation
of foreign-currency intragroup monetary balances. The parent's KES 2,630,000
receivable against the subsidiary's USD 20,000 payable diverges by KES 40,000
between the trade rate 131.5 and the closing rate 129.5; under IAS 21.45 that
belongs in the parent's profit or loss, not in a consolidation plug. Once
recognised at source, the residual disappears legitimately.

**R6 — Make the reserve articulate.** Opening + movement = closing for the
translation reserve (today all three are independent plugs), and move the group
reserve off the parent's account 3050 onto a group-chart account, with a
migration for the existing group and a default for new groups.

**R7 — Close Brick 8 for real.** Revoke the `anon` EXECUTE grants on the run
lifecycle RPCs, then drive one genuine create → finalize → supersede run against
this group and prove the finalized figures are immune to a later member rate
edit.

**Final artifact acceptance gate.** Full inventory of every consolidation
surface (Cross-Company Comparative, Consolidated TB, Consolidated Statements,
Intercompany, Eliminations) across screen / PDF / Excel: data source, screen-to
-artifact parity, totals reconciliation, identity, traceability, run-label
truthfulness, typography, and access isolation for a user who can see only some
members. Evidence listed per artifact.

## Deliberately not in this plan

No NCI, no equity method, no consolidated cash flow, and no scaffolding for
them — Brick 9 starts only after the gate above passes.

## Technical notes

- New tables: only what R4 needs for tolerance bounding and change attribution
  (either columns on `consolidation_elimination_rules` plus an audit row, or an
  extension of the existing `consolidation_group_change_log`).
- No second accounting engine: R5 reuses the existing FX revaluation path rather
  than adding a consolidation-only revaluation.
- PDF work stays inside the shared report registry and `render-report`; the PDF
  cache version is bumped whenever typography or disclosure text changes.
