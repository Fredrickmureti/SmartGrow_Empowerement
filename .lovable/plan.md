# Collections & Receivables — verification verdict, then Wave 7

## Phase 1 verdict on the previous engineer's claims

Checked directly against the codebase and the live database.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Wave 6 canonical credit/net-position views exist | CONFIRMED | `finance_ar_customer_credit`, `finance_ar_net_position`, `finance_ar_open_items`, `finance_open_items_tieout` all present in the database |
| Consumers repointed off `customer_credit_balances` | CONFIRMED in code | `src/services/finance/openItems.ts`, `src/hooks/useCustomerCredits.ts`, guards in `src/test/architecture/aging-single-source.test.ts` |
| Wave 7 item 1 — bulk statement sends routed through the durable email outbox | NOT DONE | `src/pages/CustomerStatements.tsx` still runs a browser `for` loop calling `send-document-email` one contact at a time |
| Wave 7 item 2 — send outcomes visible on Collections | NOT DONE | no reference to email/delivery status anywhere in `src/pages/sales/Collections.tsx` |

### New defect found during verification (not in the previous plan)

The bulk statement run picks its customer cohort from
`invoices.status in ('sent','partial','overdue')`. That is a status-based
receivables read — exactly what the whole programme banned. It will miss
customers whose debt comes from manual journals on the AR control account,
and include documents with no posted journal entry. It must read canonical
AR instead.

Secondary problems in the same loop: it runs in the browser (closing the tab
mid-run leaves a half-finished batch), each failure is swallowed into
`console.error` with no operator-visible record, there is no retry, and
re-running the batch re-sends every statement because nothing is keyed on
"this statement, this period, already sent".

## What I will build

### 7.0 — Bulk statement cohort from canonical AR (REPAIR)
Replace the invoice-status query with the canonical net-position source, so the
set of customers who get a statement is the same set Collections, aging and
the GL agree owes money.

### 7.1 — Durable, idempotent bulk statement delivery (HARDEN)
Move the batch off the browser. One server-side entry point accepts the period
and company, resolves the cohort, upserts the statement per customer through
the existing `upsert_customer_statement_atomic`, and enqueues one send job per
statement. A worker drains the queue, renders through the existing
`send-document-email` path (statements need the PDF attachment, so this cannot
reuse the plain `send-email` outbox flusher unchanged), retries with backoff on
transient failure, and writes every outcome to `document_emails`.

Idempotency: the job key is derived from `(statement id, recipient)`, so a
retry, a double click, or a re-run of the batch never produces a second email
for a statement already sent. No `crypto.randomUUID()` keys.

Explicitly unchanged: statement figures, `upsert_customer_statement_atomic`,
the single-send path (already audited), and the credit-note / payment-allocation
contracts.

### 7.2 — Delivery outcome visible to the collector (EXTEND)
Surface the latest `document_emails` outcome per customer on the Collections
screen and in the statements list: sent / failed / bounced with timestamp, so a
collector sees "the reminder never arrived" without leaving the page. Read-only
presentation over the existing audit trail — no new status column.

### 7.3 — Guards
Extend `src/test/architecture/aging-single-source.test.ts` so a future statement
or dunning batch cannot re-derive its cohort from invoice status, and cannot
call `send-document-email` in a client-side loop.

## Technical notes

- Queue table carries organization/business scope, statement id, recipient,
  attempt count, next-attempt time, terminal status, and a unique idempotency
  key; RLS scoped to org membership with explicit GRANTs.
- The worker is driven by the existing scheduled-automation runner, so no new
  scheduling mechanism is introduced.
- Financial truth is untouched throughout: this wave only changes who runs the
  batch, how it retries, and what the operator can see.

## After this wave (unchanged backlog)

1. Per-currency presentation for open items; FX policy for credit balances.
2. PRODUCT GAP — promise-to-pay, disputes, collector assignment, dunning
   policy, collections work queue. Each needs its own plan; none should start
   before delivery is reliable.

Known caveat carried forward: `src/test/architecture` has ~145 pre-existing
failing files unrelated to receivables. Not regressions, not fixed here.
