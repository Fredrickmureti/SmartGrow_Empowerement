# Aged Payables — AP Aging Domain Reconstruction

## What the audit found (verified, with evidence)

The Aged Payables page is not "missing a table" — it is reading a dataset that cannot answer the question the page asks. Three separate AP aging implementations exist, and only one of the AP surfaces is genuinely date-aware.

### 1. The canonical AP truth exists and is correct

`ap_subledger_entries` (org/business/branch, `contact_id`, `entry_date`, `debit`/`credit`, `source_type`, `journal_entry_id`) is the GL-anchored AP subledger. `vendor_ledger_entries` is the view over it that unions bills, bill payments and vendor credit notes with an entry date. Vendor Statements already fold this ledger bounded by `period_end`, so statements are as-of correct.

### 2. Aged Payables reads a "current time" projection, so "as of" is a lie

`get_ap_aging_summary` reads `public.finance_ap_open_items`. That view computes:

- `applied_amount` = SUM of **all** `bill_payment_allocations` for the bill, with **no date filter**;
- plus SUM of **all** non-draft `vendor_credit_note_applications`, again with no date filter.

`bill_payment_allocations` has no settlement date of its own (only `created_at`); the settlement date lives on `bill_payments.payment_date`, and credit application dates live on `vendor_credit_notes.credit_date` / `vendor_credit_note_applications.applied_at` — neither is consulted.

Consequence: running Aged Payables "as of 31 July" subtracts payments made in August. The as-of date only filters `document_date`, i.e. it hides new bills but not later settlements. Every historical AP position the report produces is wrong, and it can never agree with a Vendor Statement for the same date.

### 3. Currency is mixed inside one total

`get_ap_aging_summary` buckets `o.residual_amount` (document currency) but subtracts `finance_ap_vendor_credit.base_credit_amount` (base currency, converted at `CURRENT_DATE`, not the as-of date). A foreign-currency payables book therefore produces a total that adds two different units. The view already exposes `base_residual_amount`; the report does not use it.

### 4. Vendor credit is dumped into the wrong bucket and ignores branch

Unapplied vendor credit is subtracted from the `current` bucket only, is not scoped by `branch_id` (the view has no branch column) while the bills are, and is not bounded by the as-of date. A branch-scoped report can therefore net an organization-wide credit against one branch's bills, and the `current` bucket can go negative for reasons that are not explainable from any bill.

### 5. Three divergent aging engines

| Engine | Consumer | Bucket rule |
|---|---|---|
| `get_ap_aging_summary` | Aged Payables page | `finance_aging_bucket(due_date, as_of)`; NULL due date → `current` |
| `get_ap_summary` | AP KPI cards (`useApSummary`) | Inline `GREATEST(0, as_of - COALESCE(due_date, document_date))`, different edges, different credit netting |
| `get_ar_ap_aging_from_ledger` | Reports > Aging Report | `finance_aging_bucket`, plus credit rendered as negative pseudo-documents |

The same vendor, same date, three different numbers. `finance_aging_bucket` is the correct single boundary definition and is already mirrored once in `src/services/finance/aging.ts`.

### 6. Other confirmed defects

- Bills with status `paid` are excluded from `finance_ap_open_items` by status, on top of the residual test — a bill wrongly flagged paid silently vanishes from payables.
- `src/pages/purchases/AgedPayables.tsx` is `@ts-nocheck` and re-implements totals in the browser off untyped RPC JSON.
- Manual AP journals are included as open items with `due_date = entry_date`, so a manual accrual is instantly "overdue" — needs an explicit rule, not an accident.

## What gets built

### Phase 1 — As-of AP open items (database, foundation)

Objective: one function that answers "what was open, per bill, on date D".

- New `public.finance_ap_open_items_as_of(_org, _business, _branch, _as_of)` built on `ap_subledger_entries`: obligation rows from bill postings with `entry_date <= as_of`, settlements (payments, credit applications, reversals) also bounded by `entry_date <= as_of`, netted per bill.
- Returns document currency **and** base currency, using the FX rate at the as-of date via the existing `to_base_amount`.
- Keeps `finance_aging_bucket` as the only bucket definition. Explicit rule for NULL due dates: fall back to document date (documented, not implicit).
- Acceptance: for a bill paid after the as-of date, the function returns the full residual; recomputing yesterday's report tomorrow returns the identical number.

### Phase 2 — Single AP aging engine

- Rewrite `get_ap_aging_summary` on top of Phase 1: per-vendor buckets, per-bill drill-down rows (original, paid, credited, residual, due date, days overdue, bucket, journal entry id), branch-scoped and as-of-scoped vendor credit shown as its own explicit line rather than silently netted into `current`.
- Repoint `get_ap_summary` (KPI cards) and the AP branch of `get_ar_ap_aging_from_ledger` at the same function, then delete their private aging arithmetic.
- Acceptance: Aged Payables total, AP KPI total, Reports aging total and Vendor Statement closing balance agree for the same vendor/branch/date.

### Phase 3 — Reconciliation to the GL

- `finance_ap_aging_reconciliation(_org,_business,_branch,_as_of)`: aging total vs AP control-account balance from `ap_subledger_entries` as of the same date, returning the variance and the documents causing it.
- Surface the variance in the page header so an out-of-balance book is visible instead of silently wrong.

### Phase 4 — Page reconstruction

Rebuild `src/pages/purchases/AgedPayables.tsx` (remove `@ts-nocheck`, typed hook `useApAging`, no browser arithmetic):

- Summary band: total outstanding, not due, 0–30, 31–60, 61–90, 90+, unapplied credit, GL variance.
- Vendor aging table with the bucket columns and a total, sorted by exposure.
- Drill-down per vendor → bills, each row showing original / paid / credited / residual / due date / days overdue / bucket, with links to the bill, the vendor, the vendor statement and the journal entry.
- As-of date, branch scope and vendor search drive the server query only; server-side pagination for large books.
- Export uses the same server dataset as the screen.

### Phase 5 — Drift removal and guards

- Delete the superseded aging arithmetic left in `get_ap_summary` and the AP path of `get_ar_ap_aging_from_ledger`; keep the function names as thin wrappers only where callers still need their shape.
- Extend the existing architecture tests: no AP surface may compute buckets client-side, none may read `bills.status`/`amount_paid` for payables, and every AP aging surface must resolve to the Phase 1 function.
- Scenario tests A–J from the brief (not due, overdue, partial, multi-payment, one payment across bills, vendor credit, reversal, historical as-of, multi-currency, branch scope) as SQL fixtures.

## Technical notes

- No new tables. The obligation ledger already exists; the missing piece is a date-bounded projection of it.
- `finance_ap_open_items` stays for now as a "current position" view; after Phase 2 its only callers are re-pointed, and it is deleted in Phase 5 if nothing else depends on it.
- Supplier identity resolution stays on `contacts` + supplier role — no new vendor identity is introduced.
- All aggregation stays server-side and `SECURITY DEFINER` with org membership checks, matching the existing finance RPC convention.
