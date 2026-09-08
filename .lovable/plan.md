# Wave: Client admission fee + live end-to-end verification

Confirmed by reading the code: all fee machinery today is loan-scoped
(`mf_loan_product_versions.fees` → `mf_compute_loan_fees` → posted at
disbursement via the `fee_income` mapping in `useMfAccountMappings`). There is no
client-level charge anywhere. Group creation and membership stay plain records —
no fee, no gate, no group account. That part is correct and is not touched.

## Wave 1 — Client admission fee (the one real gap)

A one-time, per-client, configurable charge that is institution income.

1. **Configuration.** One institution-level lending setting: admission fee
   amount + currency + whether it is active. No hardcoded amount; if the
   institution leaves it blank, nothing changes anywhere in the app. Surfaced in
   Lending → Settings beside the existing lending configuration.
2. **Charge record.** One new table for admission fees raised per client
   (client, amount, currency, status, receipt/reference, timestamps), with grants
   and RLS in the same migration, matching the existing `mf_*` pattern.
3. **Server-owned money path.** Raising and paying the fee are server routines
   that reuse the existing event → posting chain (`mf_post_event` →
   `mf_resolve_account` → `post_journal_entry_atomic`), crediting the same
   `fee_income` mapping and debiting cash/bank as chosen at payment. The browser
   never computes or posts an amount. Duplicate reference is rejected; reversal
   creates a reversing entry and keeps the original record.
4. **Screens.** On the client record: fee status, "record admission fee payment"
   using the existing payment dialog pattern, and a receipt through the existing
   document engine. No new renderer, no invoice.

Explicitly out: group fees, savings, deposits, passbook fees, any
non-documented charge.

## Wave 2 — Live end-to-end verification (no new features)

Run against this database only, reusing existing test rows where they exist:

1. Branch → officer → group → members → application → approval → loan.
2. Disbursement: fee lines resolve server-side, journal balances, mapped
   accounts correct, net disbursed = principal − deducted fees.
3. Repayment: exact, partial, overpayment, multi-installment, arrears.
4. Duplicate reference rejected; reversal preserves the original and produces a
   balanced reversing entry.
5. Admission fee: raise, pay, receipt, duplicate, reversal.
6. After each case: allocations, installment state, balance, arrears, PAR and
   report visibility.

Anything that fails is fixed in code, not written up.

## Working rules

One migration = one object group. No frontend-authoritative financial math. No
second implementation where an engine exists. Untouched: orphaned ERP tables,
the group model, and everything already marked out of scope in `roadmap.md`.

## Technical notes

- New setting joins the existing lending settings surface rather than a new
  settings app.
- Fee posting keys off the existing `fee_income` mapping key; no new mapping key
  unless the institution asks to separate admission fee income.
- Client-level fee is independent of loan cycle: it is not added to a loan
  schedule and never appears in `mf_compute_loan_fees`.


==============CLOSED — VERIFIED ON LIVE DATA (2026-09-08)==========

Wave 1 and Wave 2 are complete. Evidence from the live database:

- Policy: `mf_client_fee_policy` holds one active row (KES 150, institution
  configurable). No amount is hardcoded in the frontend.
- Persisting end-to-end run: new client `CL-1003` created, added to
  `E2E Test Group`, admission fee raised and paid in cash.
- Receipts issued in sequence: `ADM-202609-00001..00003`.
- Accounting per paid fee, balanced and branch-attributed:
  Dr 1111 Petty Cash 150.00 / Cr 4320 Loan Fee Income 150.00.
- Duplicate raise for a client that already has a fee: rejected
  ("This client already has an admission fee on record.").
- Duplicate payment reference: rejected; the charge only settled once a fresh
  reference was supplied.
- Reversal (`V1-CLI-001`): original charge retained with status `reversed`,
  original entry `JE-00034` marked reversed, mirror entry `JE-00035` posted
  (Dr fee income / Cr petty cash). No financial history deleted.

Nothing outstanding on this plan.


