# Collections & Receivables Convergence — live status

Authoritative status file. Full audit and findings live in
`.lovable/plan/collections-receivables-operations-audit-and-convergence-pla-2026-08-10.md`.

North star: Collections is a trusted **operational layer over canonical AR
truth**. Receivables, aging and exposure come from the GL-gated projections
(`finance_ar_open_items` / `finance_ap_open_items`) and their derived
canonical views — never from document status, never re-derived in app code.

## Completed and verified

| Wave | Scope | Evidence |
| --- | --- | --- |
| 0 | Audit + drift sensor (`finance_open_items_tieout`) readable by audit role | tie-out re-read: `ar` drift `0.00` |
| 1 | Collections UI on canonical buckets (`Not Due` column, `In Credit` filter) | `src/pages/sales/Collections.tsx` |
| 2 | One aging source; statements age as of `period_end`, not the browser clock | `useAgingReport`, `useCustomerStatements`, `useVendorStatements`; guard test |
| 3 | AR summary nets unapplied customer credit | `get_ar_summary` |
| 4 | Statement idempotency (`customer_statements_one_per_period` + `upsert_customer_statement_atomic`); legacy `invoice_reminders` / `invoice_emails` / `invoice_activities` retired; failed sends now written to `document_emails` | migration + `send-document-email` |
| 5 | Currency integrity: `currency`, `exchange_rate`, `base_residual_amount` on both projections; tie-out and all aggregates in base currency | views + `src/services/finance/openItems.ts` |
| 6 | Credit-netting consolidation: `finance_ar_customer_credit` (one definition of unapplied credit) and `finance_ar_net_position` (server-side per-customer buckets, net of credit). `get_ar_summary`, `get_ar_ap_aging_from_ledger`, `fetchTopOpenCounterparties`, `fetchUnappliedCustomerCredit`, `useCustomerCredits` all repointed; `get_ar_summary` now sums base-currency residuals | migrations + guards in `aging-single-source.test.ts` |

Guards in `src/test/architecture/aging-single-source.test.ts`:
one bucket implementation; no legacy bucket field names; no raw
`residual_amount` cross-row aggregates; statements age as of `period_end`;
no direct `.from("customer_credit_balances")` read.

## Active phase

**Wave 6 — complete.** Nothing is half-built: every consumer named above was
migrated in the same change, and typecheck plus the receivables guard tests
pass.

## Next milestone — Wave 7: statement/dunning delivery reliability

1. Route **bulk** statement sends through `email_event_outbox` +
   `flushEmailOutbox` so batch sends get the same retry/backoff and audit trail
   single sends now have. Single-send path is already fully audited.
2. Surface send outcomes (`document_emails.status`) on the Collections screen
   so a collector can see "reminder bounced" without leaving the page.

## Backlog (after Wave 7, in order)

3. Per-currency presentation: projections expose `currency` but no UI shows a
   currency breakdown; also decide an FX policy for credit balances
   (`finance_ar_customer_credit.base_credit_amount` is currently 1:1).
4. PRODUCT GAP — promise-to-pay, disputes, collector assignment, dunning
   policy, collections work queue. All unbuilt; each needs its own plan.

## Instructions for the next agent

1. **Verify before you build.** Confirm Wave 6 is enterprise-grade:
   - `select * from finance_ar_net_position limit 5` and
     `select * from finance_ar_customer_credit limit 5` return rows scoped to
     the caller's org (both are `security_invoker`; the net-position view also
     carries an explicit `is_org_member` guard because
     `finance_ar_open_items` is owner-run).
   - `get_ar_summary`, `get_ar_ap_aging_from_ledger`, the sales dashboard KPIs
     and the Collections screen must agree on the same customer, to the cent.
   - `finance_open_items_tieout` must still show `0.00` drift for `ar` and `ap`.
   - `bunx vitest run src/test/architecture/aging-single-source.test.ts
     src/test/architecture/compensation-writer-monopoly.test.ts` must pass.
2. **Then resume at Wave 7 item 1** (bulk statement sends through
   `email_event_outbox`). Do not start the PRODUCT GAP features before the
   delivery layer is reliable — a dunning workflow on an unreliable sender is
   an incomplete business workflow.
3. Keep this file updated as each item lands: what is done and verified, what
   is pending, which phase is active, what is next.

## Known repo-wide caveat

The full `src/test/architecture` suite has ~145 pre-existing failing files
unrelated to receivables (WMS topic vocabulary, etc.). They predate this work;
do not treat them as Wave 6 regressions, and do not fix them inside a
receivables phase.
