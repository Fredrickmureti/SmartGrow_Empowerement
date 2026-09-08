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


==============IMPLEMENTATION PROGRESS/STATUS/WHERE THINGS STAND==========

Wave 1 is complete and verified live (2026-09-08).

Built and confirmed present:
- `mf_client_fee_policy` (amount, currency, on/off — institution level, no hardcoded amount).
- `mf_client_charges` (per-client charge record, receipt number, reference, journal links,
  reversal columns) with grants + RLS.
- Server routines `mf_raise_client_admission_fee`, `mf_pay_client_charge`,
  `mf_reverse_client_charge` — permission-checked, mapping-driven, posting through
  `post_journal_entry_atomic`.
- UI: Lending → Configuration admission fee card; Clients list admission-fee column +
  Manage dialog (hidden when the policy is off); receipt registered on the existing
  receipt document type.

Live end-to-end run against this database (client V1-CLI-001, KES 150 policy):
1. Raise → charge `ADM-202609-00001`, status outstanding.
2. Pay (cash, ref ADMTEST-001) → JE-00034: DR Cash 150 / CR Fee income 150. Balanced,
   mapped accounts correct (`cash`, `fee_income`).
3. Duplicate payment with the same reference → refused.
4. Reverse → original charge retained (status `reversed`, original journal intact) and
   JE-00035 posted as the exact mirror. Balanced.

Verdict: the admission fee path works end to end — configuration, obligation, payment,
accounting, duplicate control and reversal.

Residual test data left in place deliberately: the policy row (KES 150, active) and the
reversed charge with its two journal entries. Change the amount or switch the fee off in
Lending → Configuration; there is no hardcoded amount anywhere.

Remaining (Wave 2): the broader loan-cycle re-verification listed above — disbursement fee
lines, repayment cases (exact/partial/over/multi-installment/arrears), and PAR/report
visibility after each case.
