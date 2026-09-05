# Smart Grow Empowerment — Microfinance Platform

Authoritative execution plan. Backend: external Supabase `xwxqunklduknceoryrha`
(connected; service-role key stored). One institution, employee-operated,
ASA-style branch model: group meetings as the collection point, individual client
obligors, no joint liability. No multi-tenancy, no client portal, no payroll.

## Current wave

```text
PAYMENT / SETTLEMENT ENGINE
Status: INVESTIGATION — engine verified healthy in the database;
        the reported failure is not yet reproduced.
```

## Locked decisions (do not re-litigate)

Reused foundation: document generation engine · auth / PIN / invitation engine ·
navigation, app shell, UI system · report engine · institution settings · audit
logging · storage · finance core (Chart of Accounts, journals, GL, fiscal periods,
fixed assets, banking + reconciliation).

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, consolidation, multi-tenancy, client portal, FX reporting.

Invariants:
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears and PAR are DB views.
- Every state change is a business event; never `UPDATE loans SET …`.
- Account mapping stays configurable; no account UUIDs in React.
- One migration = one object group, FK-ordered, verified before the next.
- Retarget mature engines; never write a second implementation.
- Financial history is append-only: reverse, never delete.

## Payment engine — verified findings (2026-09-05, read from live DB + code)

Do not repeat these investigations.

- One authoritative entry point: `public.mf_record_repayment(p_loan_id, p_paid_on,
  p_amount, p_method, p_reference, p_batch_id, p_notes)` — SECURITY DEFINER,
  `search_path=public`, EXECUTE granted to `authenticated`. Reversal:
  `mf_reverse_repayment(p_repayment_id, p_reason)`, same posture.
- Inside one transaction it: locks the loan `FOR UPDATE`; checks
  `user_has_business_access`; refuses non-`active` loans; refuses a duplicate
  non-reversed `reference` on the same loan (idempotency guard exists); mints
  `RCP-YYYYMM-NNNNN` with a unique-violation retry loop; reads the configurable
  allocation order from `mf_allocation_policy` (default penalty → fee → interest
  → principal); allocates oldest-installment-first across
  `mf_loan_installment_status` and `mf_loan_penalty_status`; carries prior
  `advance` credit; books the excess as `advance`; writes a
  `repayment_recorded` row to `mf_loan_events`; calls `mf_post_event`; and closes
  the loan when nothing is outstanding.
- Schedule stays contractual: `mf_loan_schedule` is untouched by payments;
  settlement is derived by the `mf_loan_installment_status` /
  `mf_loan_penalty_status` views from allocations.
- Accounting is event-driven: `mf_event_postings(loan_event_id, journal_entry_id,
  posting_kind)` links each event to a journal entry; reversals post
  `posting_kind='reversal'`, originals are preserved.
- Frontend calls exactly this RPC — `src/hooks/useMfRepayments.ts`
  (`record`, `reverse`), consumed by `RecordPaymentDialog`, `RepaymentsPage`,
  `GroupSheetDialog` (per-member rows inside one batch), `CollectionsPage`,
  `useMfGroupSheet`. No allocation maths in React.
- Group model is already correct: `mf_loans.group_id` is operational only; each
  member holds an individual loan, schedule, repayment and allocation.
  `mf_repayment_batches` represents the meeting, not a joint obligation.
- Live data proves the path runs end to end: 5 loans (5 active, 3 group / 2
  individual), 40 schedule rows, 5 repayments, 13 allocations, 12 event postings
  including one `reversal`, 12 configured account mappings (cash, bank,
  mobile_money, interest_income, write_off_expense, suspended_interest, …).

### Architecture verdict

```text
CORRECT AND REUSABLE — no rewrite, no new payment tables.
```

## Open question — the actual failure

The reported symptom ("a payment cannot be settled") does not reproduce at the
database level. The remaining candidates are all browser/session-side, and the
exact error has not been captured yet. Step 1 below captures it before anything
is changed.

## Milestones

### M0 — Reproduce and fix the settlement failure (this wave, active)
1. Sign in to the preview as the test administrator and record a payment on an
   active loan through `RecordPaymentDialog`; capture the exact toast text,
   console error and the PostgREST response.
2. Match the captured error to the raise sites already mapped above (permission,
   loan not active, duplicate reference, missing account mapping, closed fiscal
   period, RLS on `mf_repayments` / `mf_repayment_allocations` reads).
3. Repair at the layer that owns the invariant — smallest change, existing
   objects. No new tables unless the captured error proves the model cannot carry
   the event.
4. Re-run the failing case, then the regression suite in M0b.

### M0b — End-to-end proof (run after the fix, signed in, real data)
Individual borrower and group meeting, each verified through the UI and then
confirmed in SQL (allocations, installment status, loan balance, arrears/PAR,
journal entry, receipt document, report visibility):
A exact installment · B partial · C overpayment (advance credit) · D multi-
installment · E arrears · F group collection across members · G duplicate
reference refused · H reversal preserving history.
Record test data, expected, actual and PASS/FAIL in the log below.

### M1 — Owner verification pass (open)
`/lending` and children open; dashboard KPIs and PAR render; one lending report,
one client statement, one repayment receipt, one disbursement confirmation render
through the shared document engine.

### M5 — Dead ERP table groups (remaining: 2 steps)
5a. `payments` / `payment_allocations` — ERP customer receipts; nothing in lending
    writes them. Retarget or delete the three readers (fiscal-period detail should
    read `mf_repayments`; clearable-payments and governed-entity options drop the
    `payments` branch), then one migration drops both tables + FKs
    (`mpesa_c2b_transactions`, `transactions`, bank match columns). Same step:
    sweep the ERP widget ids out of `useDashboardComposition`.
5b. `contacts` — journal-entry counterparty points at `mf_clients` (optional,
    nullable); command palette / entity resolver / studio catalogue / dashboard
    composition drop the contacts provider. Then one migration drops `contacts`
    + address/hierarchy tables. Verify journal entry create/view after.

### M7 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches. Never touch `mf_*`.

### M8 — Linter posture on retained schema only
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes,
leaked-password protection.

### M9 — Microfinance report completion
Officer/branch collection performance, disbursement register, product
performance, aging/DPD bands on the existing engine.

### M10 — Microfinance documents completion
Loan agreement, repayment schedule, loan statement, disbursement confirmation,
collection receipt through the existing document engine.

Closed: M2 reports, M3 money-in/out, M4 finance config, M6 FX purge, M5 sales /
purchasing / logistics / projects steps.

## Future cleanup (not this wave)
Remaining ERP leftovers: `contacts`, `payments`, `payment_allocations`, ERP
dashboard widget ids.

## Progress log (latest first)
### 2026-09-05 — Payment engine traced end to end (code + live DB). Verdict:
CORRECT AND REUSABLE; single authoritative RPC, configurable allocation order,
derived settlement views, event-driven accounting, existing idempotency guard,
append-only reversal, group-as-operational-structure already correct. Reported
settlement failure not reproducible from the database; next step is capturing the
real browser error before any change.
### 2026-09-04 — KYC images: private `mf-kyc` bucket, 5 path columns on
`mf_clients`, camera capture in `ClientFormDialog`.
### 2026-09-04 — Plan re-verified by new owner; remaining ERP tables reduced.
### 2026-09-04 — M5 projects DONE; logistics/costing DONE; M6 closed.
### 2026-09-04 — M5 purchasing/AP and sales/AR chains DONE.
### 2026-09-04 — M4 closed; M3 closed; report catalogue microfinance-only.


==============THIS WAS THE LAST MESSAGE THE AGENT GAVE BEFORE ITS TIME RUN OUT=================
Here's where things stand.

What was wrong: payments were recorded but failed at the bookkeeping step. The loan-event posting routine was calling an old version of the accounting routine that no longer exists in the database, so every payment errored out before it could settle.

What I fixed: the posting step now calls the current accounting engine, with the correct arguments.

What's still blocking: the accounting engine itself has a second, unrelated defect — it checks entries against a status value ("voided") that isn't valid; the only valid values are draft, posted and void. Until that one word is corrected, payments will still fail at the same point.

Remaining work: correct that status value, then re-run the full verification set I'd planned — single payment, partial, overpayment, arrears, group meeting collection, duplicate-reference protection, reversal, receipt and reporting — and clean up the test payments afterwards. Nothing has been left in a half-posted state; the failed attempts rolled back cleanly and no financial history was touched.