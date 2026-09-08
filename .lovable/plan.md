# Finance Domain Reconstruction — Microfinance (investigation verdict + waves)

## What the investigation actually found

Verified against the live database and code, not names or comments.

**A lending accounting engine already exists and is sound.** `mf_post_event`
posts every loan event through the single canonical writer
`post_journal_entry_atomic`, resolves accounts through `mf_resolve_account` /
`mf_account_mappings` (12 keys, branch-overridable), stamps `branch_id`, is
idempotent (`mf_event_postings` unique per loan event, early return when a
posting exists), and reverses through `void_journal_entry_atomic` rather than
deleting. Events covered: `loan_disbursed`, `repayment_recorded`,
`repayment_reversed`, `disbursement_reversed`, `loan_written_off`,
`loan_settled_by_successor`. Repayment allocation is server-owned
(`mf_record_repayment` + `mf_allocation_policy`, penalty → fee → interest →
principal, oldest installment first, overpayment parked as `advance` against
2410 Client Loan Advances). Verdict: **KEEP. Do not rebuild.**

**Actual GL activity is lending-only.** All 26 journal entries have
`source_type` in (`mf_loan_event`, `mf_collection_banking`) and all land in the
`MISC` journal book. Only six accounts have ever been touched: 1030 Mobile
Money Wallet, 1111 Petty Cash, 1112 Bank, 1370 Loan Principal Receivable, 2410
Client Loan Advances, 4310 Loan Interest Income. Every ERP account (Inventory,
COGS, Sales Revenue ×3 duplicates, VAT, GRNI, POS/Credit-card clearing, payroll
payables) has **zero journal lines** — they are seed residue, not history.

**Journals**: 5 seeded books; `SAL` (Sales) and `PUR` (Purchases) have zero
entries and nothing in the lending path can ever route to them.

**Finance Settings UI is already curated** — `DefaultAccountsConfig` exposes
cash, bank, AP, operating expenses, retained earnings, tax, fixed assets,
depreciation, opening-balance equity, other income, mobile money, M-Pesa. The
ERP terminology visible on screen comes from the **Chart of Accounts list** and
the 41 rows in `default_account_settings` (inventory, cogs, grni,
purchase_returns, inventory_shrinkage…), not from the lending engine.

### Defects found

- **D-1 (real, latent).** `loan_written_off` credits `interest_receivable`
  (1375) for written-off interest, but **nothing ever debits 1375** — no accrual
  engine exists. A write-off of a loan with unpaid interest posts a credit to an
  account with no balance, producing a negative asset and overstating write-off
  expense. This is the one genuine accounting defect in the engine.
- **D-2.** `loan_loss_provision` (2420) and `suspended_interest` (2430) are
  mapped but no function ever posts to them: **no impairment at all**.
- **D-3.** `mf_accrue_penalties` raises penalty charges in `mf_loan_charges`
  with no GL effect; penalty income is recognised only on payment. Consistent
  with the cash model below, so **not** a defect — but it must be stated, since
  the charge table and the GL deliberately disagree.
- **D-4.** Fee income at disbursement is netted off cash
  (`fees_deducted`) — correct — but fees billed and collected later flow only
  through the repayment allocation path. Acceptable; documented.

## Decisions (evidence → reasoning → decision)

**1. Interest recognition: modified cash basis now, accrual-ready structure.**
*Evidence*: income is recognised at allocation time in `mf_post_event`; 1375 and
2430 exist but are never posted; no month-end job, no non-accrual status, no
provision engine. *Domain basis*: MFIs of this size in Kenya commonly report on
a cash/modified-cash basis, and IFRS-style effective-interest accrual on flat-rate
group loans requires a suspension policy, an impairment model and a month-end
close the institution does not yet run. Introducing accrual **without**
suspension and provisioning would overstate income on delinquent loans — worse
than cash. *Decision*: keep cash recognition as the reporting model; fix D-1 so
the write-off path stops referencing an unaccrued receivable; keep 1375/2430
mapped and reserved; treat accrual as a later, explicitly gated wave that ships
accrual + suspension + provision + month-end close **together or not at all**.
*Consequence*: interest income equals interest collected; accrued-but-unpaid
interest is a portfolio number (schedule-derived), never a GL asset — and
reports must say so.

**2. Journals: keep the generic book engine, retire misleading books.**
`SAL`/`PUR` are unreachable and unused → deactivate (not delete: `is_system`
rows are referenced by book-assignment logic). Add one `LND` Lending book and
route `mf_loan_event` postings to it so lending stops sharing `MISC` with manual
adjustments. No per-event journals (no "Interest Journal") — the posting engine
already carries `source_type`/`source_subtype`, which is the correct dimension.

**3. Chart of accounts: deactivate, never delete history.** Accounts with zero
journal lines **and** no mapping/setting reference and clearly ERP
(inventory, COGS, GRNI, POS clearing, credit-card clearing, purchase returns,
inventory adjustment/shrinkage/revaluation/overage, duplicate Sales Revenue
4010/4100/4110/4120, product sales, payroll statutory/pension/net-salary
payables, duplicate Furniture & Fixtures 1510) → `is_active = false`.
Tax accounts (2130 VAT Payable, 1310/1150 input VAT) → **KEEP**: the institution
is Kenyan and charges VAT-able fees and pays withholding tax on some expenses.
Accounts referenced by any mapping or setting → KEEP regardless of usage.

**4. Multi-branch: dimension, not a second ledger.** One company, one COA, one
book set; `branch_id` on every journal entry (already stamped) plus
branch-level mapping overrides (already supported in `mf_account_mappings` /
`branch_setting_overrides`). No per-branch COA, no inter-company.

**5. Reconciliation matches bank statement lines to lending money movement**
(collection bankings, disbursement payouts, transfers) — the invoice matching
target is a generic optional matching abstraction and stays, unused.

**6. Authorization: reuse the existing engine.** Finance configuration writes
go through the existing permission modules + `approval_route`/SoD triggers. No
parallel permission system, no new gate.

**7. Historical integrity.** Mapping changes must never rewrite postings.
Postings already dereference accounts at post time, so history is immutable by
construction; what is missing is an audit trail on mapping changes
(`mf_account_mappings` has none) → add one.

## Waves

### Wave F-1 — Chart of accounts triage (safe, reversible)
Objective: the COA reads as a microfinance COA with zero history loss.
Changes: one migration deactivating the zero-usage ERP accounts listed in
decision 3; a guard function refusing deactivation of an account that has
journal lines or is referenced by `mf_account_mappings` /
`default_account_settings` / `default_accounts`.
DB: `accounts`, new `accounts_assert_deactivatable` check in the update trigger.
Frontend: Chart of accounts already filters inactive; add an "Show inactive"
toggle so nothing becomes invisible.
Tests: SQL test — no account with journal lines is inactive; no mapped account
is inactive. Acceptance: COA list shows only lending/finance-relevant accounts;
trial balance unchanged to the cent.
Risk: low. Rollback: single UPDATE flipping `is_active` back (commented in the
migration).

### Wave F-2 — Journal books
Deactivate `SAL`/`PUR`, insert `LND` Lending journal, extend book assignment so
`source_type = 'mf_loan_event'` and `mf_collection_banking` resolve to `LND`,
leaving `MISC` for manual entries. Existing 26 entries are **not** re-pointed
(history immutable); reports group by book from the entry's stored book.
Tests: new lending posting lands in `LND`; a manual journal still lands in
`MISC`. Rollback: re-activate SAL/PUR, revert assignment function.

### Wave F-3 — D-1 write-off correctness (the real accounting fix)
Root cause: `loan_written_off` credits 1375 for interest that was never accrued.
Fix: under cash recognition a write-off may only remove **principal** from the
balance sheet; unpaid interest is de-recognised in the portfolio, not the GL.
`mf_post_event` write-off branch → debit `write_off_expense` and credit
`principal_receivable` for principal only; unpaid interest recorded in the event
payload for portfolio reporting with no GL line. Add a hard assertion that the
lines balance and that 1375 is never credited without a prior debit.
Tests: write off a loan with unpaid interest → JE balances, 1375 untouched,
write-off expense equals principal; repeat call is idempotent.
Risk: changes an existing posting rule → apply before any real write-off exists
(currently none in the data).

### Wave F-4 — Mapping-change audit + effective integrity
Add `mf_account_mapping_audit` (append-only: key, old/new account, actor,
branch, reason) and a trigger on `mf_account_mappings`; surface last-changed-by
in the Finance Settings mapping UI. Confirms decision 7 without effective dating
(not needed, since postings snapshot the account at post time).

### Wave F-5 — Finance Settings surface alignment
Hide/remove the ERP-only `default_account_settings` keys that no live consumer
reads (inventory, cogs, grni, purchase_returns, inventory_*, discount_*,
clearing_pos, credit_card_clearing, customer_deposits, sales_revenue,
sales_returns, service_revenue) — rows retained, excluded from the settings
catalogue; add the lending mapping block (principal receivable, interest/fee/
penalty income, client advances, write-off expense, provision, suspended
interest, cash/bank/mobile money) as the primary section, since that is what the
posting engine actually resolves. Permissions: mapping writes gated by the
existing finance-configuration permission, not a new one.

### Wave F-6 — Engine verification on real data
Controlled end-to-end tests against the microfinance database as
`fredrickmureti612@gmail.com`: individual loan → schedule → partial payment →
full payment → overpayment (advance) → multi-installment payment → arrears →
penalty accrual → reversal → write-off → collection banking → bank
reconciliation → branch report. Invariants asserted each step: debits = credits,
duplicate receipt reference refused, reversal preserves history, loan balance =
schedule − allocations, branch attribution intact, second identical post is a
no-op.

### Wave F-7 (gated, not yet approved for build) — accrual + impairment
Only if reporting requirements change: accrual of interest earned, non-accrual
suspension at an arrears threshold (2430), portfolio provision matrix (2420),
month-end close job, and the reporting changes. Ships as one unit. Recorded here
so the mapped-but-unused accounts have a documented destiny.

## Out of scope
HR, payroll, inventory, sales, CRM, POS, broad orphan-table cleanup, report
redesign, authentication, application shell.

## Migration discipline
One object per migration, in wave order F-1 → F-2 → F-3 → F-4; every migration
delete-free (deactivation only) and carrying a commented rollback statement.


=================IMPLEMENTATION STATUS/PROGRESS AND WHERE THINGS STAND================


Completed — journals (Wave F-2)

Created the Lending Journal (LND) for the institution.
Loan events and collection banking now record into it automatically; everything else is unchanged, with a safe fallback to the general journal.
Retired the unused Sales and Purchases journals (marked inactive, only because they hold no entries — nothing deleted, reversible).
New companies will be set up with the Lending journal from the start.
In progress — write-off correctness (Wave F-3) This is the one real accounting defect: a write-off was removing unpaid interest from the balance sheet even though interest is only recognised as income when a client pays, so that interest was never an asset. The corrected version posts principal only, notes any unpaid interest on the entry description for portfolio reporting, and produces no entry at all for an interest-only write-off. My migration was rejected on a typo (a stray leftover line, v_fees_block, in the disbursement section) — the fix is to delete that one line and re-apply the same function; no other change is needed. No loan has been written off in the data yet, so nothing is currently mis-stated.

Remaining after that: F-4 mapping-change audit trail, F-5 Finance Settings surface alignment (hide the retail-only mappings, promote the lending mappings), F-6 end-to-end verification on real data. F-7 (accrual + impairment) stays deliberately gated.

I'll pick up at re-applying the corrected write-off function when credits are back.

