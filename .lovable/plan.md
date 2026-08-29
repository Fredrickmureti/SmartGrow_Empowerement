# Consolidation — tolerance verdict, the 1,500 / 38,500 gaps, and closing R7

## What I verified (not assumed)

**The tolerance is real, configurable — but capped by a hard-coded literal.**
`consolidation_elimination_rules` stores, per group *and per elimination class*:
`tolerance_amount`, `tolerance_reason`, `difference_policy`
(`refuse` | `post_difference` | `post_to_cta`), `difference_group_account_id`,
plus `tolerance_set_by/at` and a change-log row. So it is configurable — but
`consolidation_tolerance_cap()` is literally `SELECT 100.00::numeric`, mirrored
again as a hard-coded `ELIMINATION_TOLERANCE_CAP = 100` in the UI. That 100 is a
bare number applied to *any* presentation currency: 100 KES (~USD 0.77), 100 USD,
100 JPY are all treated as "the rounding bound". Nothing derives it from the
currency's minor unit, the group's size, or a materiality basis.

**The current group's live state.** Both rules (`intercompany_balance`,
`intercompany_trading`) sit at tolerance 100.00 with policy `refuse`, no
difference account. Group presents in KES; members are Joshua Holdings (KES,
parent) and Mombasa Port Services (USD).

**Where 1,500 and 38,500 actually come from.** The seeded books are internally
consistent, so this is not data corruption:

- JH books the recharge on 2026-06-30: Dr 1180 IC receivable / Cr 4180 IC income
  **2,630,000 KES** — that is exactly 20,000 USD × 131.50, the verified rate on
  2026-06-30.
- MPS books the mirror: Dr 5180 expense / Cr 2180 IC payable **20,000 USD**.
- JH then revalues the receivable on 2026-08-31 by −40,000 (JE-00019), leaving
  2,590,000 KES = 20,000 × 129.50 — the verified closing rate. IAS 21.23/28,
  correctly done.

So in the members' own books the pair agrees perfectly at closing. The two gaps
are produced entirely by the *group* translation step:

- balance gap 1,500 = 20,000 × (129.50 − 129.425) — the group applied a closing
  rate that is not the 129.50 the member itself revalued at. Two rate sources
  for one closing date.
- trading gap 38,500 = 2,630,000 − 20,000 × 129.575 — the parent's intragroup
  income sits at the transaction rate while the subsidiary's expense is
  translated at the average rate. Under IAS 21 that difference is *structurally
  unavoidable* and belongs in the translation reserve; it is not unrecorded
  revenue, unrealised profit or a cut-off difference.

(The exact 129.425 / 129.575 the engine resolved is arithmetic-implied; step 1
pins it from `consolidation_member_translation_rates` before anything is
changed.)

## How mature systems handle this — and where we deviate

| | tolerance | on a gap it can't absorb |
|---|---|---|
| Oracle HFM / EPM | amount **and/or** percentage, per period, per account/TID; blank = exact match | leaves unmatched for manual match; customer-configured plug |
| SAP S/4HANA Group Reporting (ICMR) | configurable tolerance per matching rule; "matched with tolerance" status | variance-adjustment posting to a configured GL account |
| NetSuite | no numeric tolerance; reconciliation report is match/no-match | still posts; FX residual goes to a dedicated **CTA-Elimination** account |
| Dynamics 365 F&O | none — rule-based elimination journals | nothing; resolve upstream |
| Odoo | none native (mapping/aggregation only) | manual journals or a paid module |

**Verdict: the architecture is right, three behaviours are wrong.**

Right: per-class rules, an explicit difference account, a mandatory reason, an
audit trail, refusing to invent a number, separating a member's own unrecognised
FX from a group difference. That is HFM/SAP-grade and better than Odoo or D365.

Deviation 1 — **the 100 cap is invented.** No mature system caps a tolerance at
a flat literal, and none makes it currency-blind. Tolerance is an admin control
governed by materiality and audit, not by a constant in a migration.

Deviation 2 — **hard-refusing the run is not industry behaviour.** Every system
surveyed plugs-and-flags; the block, where it exists, is a close-process control
(period certification), not the engine. Refuse should stay as the *default
policy*, not the only reachable outcome.

Deviation 3 — **the blanket ban on carrying a trading gap to the reserve is too
absolute.** It is correct for unrecorded/unrealised/cut-off differences. It is
wrong for the average-vs-transaction-rate residual above, which is precisely
what NetSuite sends to CTA-Elimination. The engine must tell the two apart
instead of refusing both.

## The work, in order

**T1 — pin the rates.** Read the rates the engine actually used per member and
class, and prove the 1,500 and 38,500 decompositions numerically. No changes.

**T2 — one closing rate per date.** Make member FX revaluation and group closing
translation resolve the same rate from the same resolver, so a member that has
revalued correctly cannot disagree with the group. This removes the 1,500
entirely rather than absorbing it. Regression: existing FX and translation tests.

**T3 — tolerance becomes a governed control, not a literal.**
Replace the flat cap with a materiality-based bound: tolerance may be set to any
amount, but above a currency-scaled rounding threshold it requires the reason it
already demands *and* a named difference account, and it is disclosed on the face
of the run. Add a percentage tolerance alongside the amount (HFM's "smaller of
the two wins"), and per-counterparty-pair overrides on top of the class default.
The UI cap literal goes; the client reads the bound from the server.

**T4 — classify the trading residual.** Split `intercompany_trading` gaps into
`rate_basis_residual` (explained by average-vs-transaction rate on the matched
pair — carried to a dedicated IC-elimination FX difference line in equity, the
CTA-E equivalent) and everything else (still refused, or posted to the named
difference account). The classification must be arithmetic, not a label.

**T5 — R7, close Brick 8.** Revoke `anon` EXECUTE on `consolidation_create_run`,
`consolidation_finalize_run`, `consolidation_supersede_run`,
`consolidation_diagnose_eliminations`, `consolidation_intercompany_flows`,
`consolidation_intercompany_entry_lines`, `consolidation_elimination_evidence`,
`consolidation_eliminations_balance`, `consolidation_seed_default_elimination_rules`
(all currently granted to `anon`; verified). Then drive a genuine
create → finalize → supersede against this group — `consolidation_runs` is empty,
so this has never been done — and prove finalized figures survive a later member
rate edit unchanged.

**T6 — the live elimination simulation you asked for.** With T2–T4 in place,
re-run generate against Joshua Holdings Group for the period and record, from
actual output: which pairs matched, the residual by class, where each residual
landed, whether the consolidated TB still balances, and that both original
messages are gone for the right reason (rate agreement and correct
classification) rather than because a tolerance was widened.

**T7 — final artifact acceptance gate.** Cross-Company Comparative, Consolidated
TB, Consolidated Statements, Intercompany, Eliminations — screen / PDF / Excel:
data source, screen-to-artifact parity, totals reconciliation, group identity,
traceability, run-label truthfulness, typography, and access isolation for a user
entitled to only some members. Evidence per artifact, from regenerated files
inspected page by page.

## Not in scope

No NCI, no equity method, no consolidated cash flow. Brick 9 starts only after
T7 passes.
