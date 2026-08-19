# ADR 0147 — A bank line is explained, not guessed

Status: Accepted
Date: 2026-08-19
Related: ADR-0123 (single journal posting monopoly), ADR-0136 (one FX engine; a
missing rate is an absence), ADR-0141 (a bank balance is derived, never stored),
ADR-0144 (bank reconciliation is one matching seam)

## Context

ADR-0144 made matching a single seam. It did not say what a match *means*, and
four defects lived in that gap.

1. **Matching could only mint.** Every resolution the UI offered created a new
   settlement. A receipt already recorded at the till and sitting in Undeposited
   Funds had no "clear this" path, so banking it recorded the money twice: the
   customer's invoice was over-paid and Undeposited Funds never drained.
2. **A deposit against several invoices became several settlements.** The sheet
   looped its reconcile callback once per selected document, so one bank line
   produced N payments, N journal entries and N chances to half-fail.
3. **A bank charge was netted off the document.** The residual was absorbed into
   the amount settled, so the customer appeared to have paid the charge and the
   bank line no longer equalled the statement.
4. **Suggestions were unfalsifiable and unsafe.** The suggestion RPC scored bank
   lines against a column that does not exist, carried no membership assertion,
   and was executable by `anon`.

## Decision

1. **Two kinds of resolution, named as such.** *Clearing* (`payment`,
   `bill_payment`, `transfer`) recognises money already recorded and moves it
   out of its holding account. *Settling* (`invoice`, `bill`) records new
   settlement through the AR/AP engines. *Categorising* (`account`) is the
   residual case and the weakest one. The seam validates each kind on its own
   terms: a receipt is deposited in full, at most once, and never in the wrong
   direction.
2. **One bank line is one match.** Multiple documents are multiple allocations
   on a single match, never multiple matches. The allocation set must equal the
   bank line adjusted for the named bank charge, or the match is refused.
3. **The charge is a residual, not a discount.** Documents settle gross; the
   bank moves the statement amount; the difference is posted as a bank charge
   or an explicit write-off (ADR-0144 §5) and never adjusts the document.
4. **Explanations are evidence, not scores.** `bank_match_candidates` runs
   inside the tenant boundary and returns, for each candidate, the accounting
   effect in plain English and the reasons behind it — exact amount, named
   counterparty, matching reference, date proximity, "not yet deposited". A
   tier (certain / likely / ambiguous / rule only / unexplained) is *derived*
   from which evidence classes are present and how many candidates tie. A bare
   percentage is never the basis for a posting.
5. **Candidates prefer clearing over minting.** When a recorded receipt and an
   open invoice both fit a deposit, the receipt ranks first — settling the
   invoice again is the duplicate the engine exists to prevent.
6. **Rules are subordinate to accounting truth.** A categorisation rule is
   skipped whenever any document or recorded payment could explain the line, and
   an auto-post that cannot post honestly degrades to a proposal a human sees.

## Consequences

- Undeposited Funds drains, because banking a receipt is expressible.
- A deposit covering several invoices leaves one payment and one journal entry.
- The bank line always equals the statement; the charge is visible as a charge.
- Every suggestion can be argued with, because it carries its reasons.

## Enforcement

- `src/test/architecture/banking-match-resolution.test.ts`
- `_bank_match_validate` (direction, full-clear, already-deposited, cross
  company/branch/currency, and the amount law).
- `bank_match_candidates` and `apply_reconciliation_rules` are revoked from
  `anon` and assert membership via `assert_can_reconcile_bank`.
