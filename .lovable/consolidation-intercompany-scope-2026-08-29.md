# Intercompany scope correction — 2026-08-29 (executed, verified)

## What the rates actually say

Pinned by running the engine as the group's owner over 2026-08-01..2026-08-31
for Joshua Holdings Group (presentation KES):

- Joshua Holdings (KES): all rates 1.
- Mombasa Port Services (USD): closing 129.50, average 130.7419354838709677,
  opening 133.00, historical 130.00 at 2026-05-01.

The closing rate the group translates at (129.50) is the same rate the member
revalues its own books at. The earlier theory that the 1,500 KES gap came from
a closing-rate disagreement is wrong; the rates agree.

## The real defect

`consolidation_intercompany_entry_lines` treated **every leg** of any journal
entry tagged to a sister company as an intercompany flow. One intragroup
invoice therefore dragged in:

- Cash on Hand 69.60 and Undeposited Funds 1,670.40 (money from a real bank),
- Output VAT Payable 240.00 (owed to the revenue authority),
- FX Unrealized Loss 40,000.00 (the parent's own IAS 21.45 exchange difference
  on the intercompany receivable).

Consequences, both real:

1. Eliminating those legs would have deleted third-party cash and a real tax
   liability from the consolidated balance sheet.
2. The sister holds no mirror of any of them, so they appeared as permanent
   pair differences — 1,500.00 on the balance class and 38,500.00 on the
   trading class (= 40,000 FX loss less 1,500 of sales).

`consolidation_diagnose_eliminations` then mislabelled both as
`translation_residual` purely because the two members' currencies differ, and
recommended carrying them to the translation reserve. That advice would have
buried a bookkeeping omission and a P&L item in equity.

## What changed

- New `consolidation_leg_faces_counterparty(...)`: a leg is intercompany only
  if it is the tagged reciprocal receivable/payable, or the trading leg facing
  it. Cash, bank, clearing, input/output tax and exchange gain/loss accounts
  (by `system_role` / `detail_type`) are never intercompany.
- `consolidation_intercompany_entry_lines` scopes through that predicate, and
  its "account not in the consolidated trial balance" refusal now applies only
  to legs the engine actually consumes.
- `consolidation_diagnose_eliminations`:
  - new cause `one_sided_flow` — when only one member booked anything in the
    class, the gap is a missing entry, never a retranslation artefact;
  - new cause `trading_translation_residual` — a cross-currency *trading*
    residual is never carried to the translation reserve; it belongs in a
    named difference account.

## Verified by execution

Same probe, before and after, as the group's owner:

| | before | after |
|---|---|---|
| flows | 8 legs incl. cash, undeposited, VAT, FX loss | 4 legs: 1180, 1100, 4010, 2180 |
| intercompany_balance gap | 1,500.00 KES, "translation_residual" | **0 — the pair reconciles at 2,590,000.00 KES** |
| intercompany_trading gap | 38,500.00 KES, "translation_residual" | 1,500.00 KES, `one_sided_flow`, named to both companies |

The remaining 1,500.00 is genuine: Joshua Holdings booked an intragroup sale
that Mombasa Port Services has not recorded. The engine now says so instead of
inventing an FX explanation.

## Not done yet

- T5: nine consolidation functions still carry `EXECUTE` for `anon`; the run
  lifecycle (`consolidation_runs`) is still unexercised.
- Regression tests for the new scoping predicate in
  `supabase/tests/consolidation_eliminations_test.sql`.
- The stored eliminations for 2026-08 are stale (generated under the old
  scoping) and must be regenerated once the trading gap is resolved or a
  difference policy is chosen.
