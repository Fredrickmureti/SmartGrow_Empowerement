# Collections & Receivables Convergence — live status

North star: Collections is a trusted **operational layer over canonical AR
truth**. Receivables, aging and exposure come from the GL-gated projections
(`finance_ar_open_items` / `finance_ap_open_items`) and their derived canonical
views — never from document status, never re-derived in app code.

## Completed and verified

| Wave | Scope | Evidence |
| --- | --- | --- |
| 0–5 | Audit + drift sensor, canonical buckets in Collections, one aging source with as-of dating, AR summary nets credit, statement idempotency, currency integrity | see archived audit under `.lovable/plan/` |
| 6 | Credit-netting consolidation: `finance_ar_customer_credit` + `finance_ar_net_position`; all consumers repointed | `aging-single-source.test.ts` (6/6) |
| 7 | Statement delivery reliability | `statement-delivery-durability.test.ts` (4/4) |

### Wave 7 detail

1. **Cohort from canonical AR.** `fetchReceivableCounterparties`
   (`src/services/finance/openItems.ts`) reads `finance_ar_net_position`;
   `CustomerStatements.tsx` no longer builds the bulk cohort from
   `invoices.status`.
2. **Durable, idempotent delivery.** `customer_statement_send_jobs` +
   `enqueue_customer_statement_send` / `claim_customer_statement_send_jobs`
   (SKIP LOCKED, backoff) / `complete_customer_statement_send_job`. The browser
   enqueues; `supabase/functions/_shared/flushStatementSendOutbox.ts`, called
   from `process-scheduled-automations`, sends via `send-document-email` (which
   still writes `document_emails` on both paths). A unique idempotency key per
   (statement, recipient) makes a re-run a no-op.
3. **Outcome visibility.** `useStatementDeliveryStatus` powers Sent / Queued /
   Send failed badges (with the failure reason on hover) on `/sales/collections`.

## Next milestone — backlog (in order)

1. Per-currency presentation: projections expose `currency` but no UI shows a
   currency breakdown; decide an FX policy for credit balances
   (`finance_ar_customer_credit.base_credit_amount` is currently 1:1).
2. PRODUCT GAP — promise-to-pay, disputes, collector assignment, dunning
   policy, collections work queue. All unbuilt; each needs its own plan.

## Known repo-wide caveat

The full `src/test/architecture` suite has ~145 pre-existing failing files
unrelated to receivables. They predate this work; do not treat them as
regressions here.
