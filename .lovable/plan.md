# Customer Statements — Audit Report and Convergence Plan

## Executive verdict

The Customer Statements subsystem contains **two independent statement engines**, and only one of them is correct.

- **Screen engine (canonical).** `src/hooks/useCustomerStatements.ts` builds the on-screen statement from `customer_ledger_entries` — the database view over `ar_subledger_entries`, i.e. the posted AR subledger. Opening balance = sum of `debit - credit` for all entries before `period_start`; in-period rows come from the same view; scoping is organization + business + branch, with optional commercial-partner (parent/child) consolidation.
- **Export engine (drifted duplicate).** `src/services/documents/snapshots/salesCustomerStatement.ts` (used for PDF/print/email) and its verbatim twin in `supabase/functions/generate-document/index.ts` re-derive the statement from raw `invoices`, `payments` and `credit_notes` tables. They do not read the ledger at all.

The observed `invalid input value for enum credit_note_status: "partially_applied"` is **not** an isolated typo. It is the visible symptom of the duplicate engine: the export path invented its own credit-note vocabulary (`issued, applied, partially_applied`) while the real enum is `draft, issued, applied, void, refunded`. A path that reads the posted ledger cannot make that mistake, because the ledger only contains posted effects.

Verdict: **CONVERGE the export path onto the canonical ledger.** Do not patch the enum string.

## What a Customer Statement is in this ERP

Evidence (`customer_ledger_entries`, ADR 0027, ADR 0131) establishes the canonical model already present in the database:

```text
Opening balance (posted AR subledger before period_start)
  + invoices            (debit)
  - payments            (credit)
  + payment reversals   (debit)
  - credit notes        (credit)
  - / + refunds
  = Closing balance  ==  customer ledger balance  ==  AR net position
```

The subledger view already classifies `doc_type` as invoice / payment / payment_reversal / credit_note / refund and resolves `doc_ref` from the source document. Debit-positive is the receivable direction. Customer credit is a separate liability subledger (ADR 0131) and must not be double-counted with its applications — the ledger already handles this, a re-derivation from documents does not.

## Confirmed defects in the export engine (evidence)

`salesCustomerStatement.ts:263-340` and `generate-document/index.ts:1340-1430`, identical logic:

1. **Non-existent enum value** — `.in("status", ["issued","applied","partially_applied"])`. Real labels: `draft, issued, applied, void, refunded`. PostgREST returns 400; the whole PDF fails. (REPAIR by removal, not substitution.)
2. **No invoice status filter at all** — `status` is selected but never used, so **draft, cancelled and voided invoices are charged to the customer** on the PDF while the screen (ledger-driven) excludes them.
3. **No branch scoping** — the header row carries `branch_id` and the screen filters by branch; the export queries only org + business. A branch-scoped statement can show other branches' documents.
4. **No currency handling** — invoices/payments of any currency are summed as raw numbers and stamped with the business base currency. Mixed-currency customers produce a meaningless total.
5. **Gross payments, allocation-unaware** — the canonical architecture is allocation-first; the export sums `payments.amount`, ignoring reversals and allocations.
6. **Missing event types** — refunds, deposits and payment reversals exist in the ledger and on the screen; they never appear on the PDF.
7. **No commercial-partner consolidation** — the screen can consolidate a parent/child family; the PDF silently cannot.
8. **Aging is recomputed locally** from `total - amount_paid` against `issue_date` (not due date, not the canonical `finance_ar_open_items` aging), and is anchored to `now` rather than the statement date.
9. **Representation parity is broken** — screen, PDF, CSV and XLSX can legitimately show different numbers today. The CSV export in `CustomerStatements.tsx:467` reports only the stored header columns, which are whatever the screen last wrote.

Correct and preserved (**KEEP**): `customer_ledger_entries` and `ar_subledger_entries`; `finance_ar_open_items` / `finance_ar_net_position` / `finance_ar_customer_credit`; `upsert_customer_statement_atomic` (idempotent on business+branch+contact+period, org-membership checked); the screen's ledger-derived opening/closing balance; the document-records/print pipeline.

Out of scope: payment, credit-note, refund and posting engines; vendor statements (same shape, tracked separately); collections, dunning, disputes.

## Plan

### 1. One statement dataset builder (CONVERGE)

Extract the screen's ledger read into a shared, pure module that both paths use:

- New `src/services/finance/customerStatementDataset.ts`
  - `fetchCustomerStatementLedger(supabase, {organizationId, businessId, branchId, contactIds, periodEnd})` → rows from `customer_ledger_entries`, ordered `entry_date, created_at`.
  - `buildStatementDataset({rows, periodStart, periodEnd})` → `{ openingBalance, transactions[], closingBalance, totalCharges, totalCredits }`, running balance from opening, one row per ledger entry with `doc_type`, `doc_ref`, `doc_id`, debit/credit.
  - Boundary semantics made explicit and tested: opening = `entry_date < period_start`; in-period = `period_start <= entry_date <= period_end` on the ledger's date (posting/entry date, not `issue_date`).
- `useCustomerStatements.generateStatementData` delegates to it (behaviour preserved).
- `salesCustomerStatement.ts` drops the three document queries entirely and builds `statement_transactions` from the same dataset, using the persisted header's business/branch/contact and period. `buildCustomerStatementSnapshot` stays a pure function; its input becomes the dataset rather than invoice/payment/credit-note arrays.

### 2. Aging from the canonical projection (CONVERGE)

Statement aging reads the existing AR open-items projection (`finance_ar_open_items`, as `src/services/finance/openItems.ts` already does) instead of recomputing from `invoices`, and ages against due date as that projection defines, anchored to the statement date.

### 3. Retire the edge-function twin (RETIRE)

`fetchCustomerStatement` in `supabase/functions/generate-document/index.ts` is replaced by the same ledger read (shared logic mirrored the way `statementKinds.ts` is mirrored, with a parity test) so the emailed PDF and the downloaded PDF cannot diverge.

### 4. Currency correctness (REPAIR)

The ledger carries `currency`. The statement is produced per currency: rows are filtered to the business base currency by default and any non-base-currency activity is surfaced as a disclosed separate section rather than silently summed. No FX invention — only what the ledger already records.

### 5. Isolation (REPAIR)

Every read is scoped organization + business + branch + contact family, matching the persisted header, on both paths.

### 6. Regression guards

- Extend `src/test/documents/sales-customer-statement-snapshot.test.ts` to the new dataset input (opening balance, ordering, running balance, boundary dates).
- New architecture test: no statement builder may query `invoices` / `payments` / `credit_notes` directly, and no code may reference a `credit_note_status` value outside the real enum.
- Parity test: client snapshot builder and edge-function copy produce identical transactions for the same ledger rows.
- Reconciliation test: statement closing balance for a period ending today equals `finance_ar_net_position` for that customer.

### Ordered by financial risk

1. Remove the invalid enum filter **by deleting the document queries** (fixes the 400 and the draft/void leakage in one move).
2. Ledger-backed dataset shared by screen and export.
3. Branch + currency scoping on the export path.
4. Canonical aging.
5. Edge-function convergence + parity/reconciliation tests.

### Regression risks

- Statement PDFs will change for customers whose invoices were draft/void or whose payments were reversed — this is the correction, and it aligns the PDF with the screen and the ledger.
- Documents that were never posted to the AR subledger will disappear from statements; the reconciliation test makes any such gap visible rather than silent.
- Historical `customer_statements` header rows keep their stored balances; regenerating a period re-upserts through the existing atomic RPC.

### Verification

Vitest suites above, plus a manual pass on a customer with: a voided invoice, a partially applied credit note, a reversed payment, a multi-invoice payment, and a branch-scoped period — screen, PDF, CSV and XLSX must all report the same opening balance, transaction list and closing balance, and that closing balance must equal the customer ledger page.
