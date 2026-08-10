# Order-to-Cash Trust Programme — Status & Roadmap

Authoritative status file. Update it after every completed implementation.

**Currently active phase:** Phase 3 complete — no phase in progress.
**Next phase to start:** Phase 4 (Purchases / Procure-to-Pay overview convergence).

---

## Phase 1 — Statements forensic audit and remediation — COMPLETE (verified)

All five remediation items shipped and verified against the live database.

| Item | Status | Verification |
| --- | --- | --- |
| Prove the statement renderer live | Done | Post-fix artifacts (10 Aug 05:06 and 05:19 UTC) render at ~14.2 KB with ledger layout, versus the 11.8 KB invoice-shaped pre-fix bytes |
| Quarantine pre-fix artifacts | Done | All 9 pre-fix `sales.statement` artifacts carry `superseded_by` and `regeneration_reason = 'quarantined: invoice-shaped statement layout (pre routing fix)'`; the 3 legacy `customer_statement` artifacts are superseded too |
| Separate print from download for statements | Done | `resolve_output_intent` computes `v_is_statement` and suppresses the policy-derived print target for statement kinds |
| One dispatch exit for customer statements | Done | `src/features/sales/statements/dispatchCustomerStatement.ts`, consumed by `src/pages/CustomerStatements.tsx` |
| Freeze the regressions | Done | `src/test/architecture/statement-pdf-routing.test.ts`, `statement-kinds-parity.test.ts`, `statement-delivery-durability.test.ts` |

## Phase 2 — Salesperson performance projection — COMPLETE (verified)

- `get_salesperson_performance` and `get_salesperson_performance_documents`
  own all metric logic server-side; the hook is a thin wrapper.
- Attribution inherits from the invoice (commercial owner), never the record
  creator. POS rows with an `invoice_id` are de-duplicated.
- Receivables read `finance_ar_open_items`; cash reads `payment_allocations`;
  credit reads `credit_notes` (drafts and voids excluded).
- Every metric cell drills down to its source documents.
- Guards: `supabase/tests/salesperson_performance_reconciliation_test.sql`.
- Memory: `mem://features/salesperson-performance`.

## Phase 3 — Sales Overview cockpit convergence — COMPLETE (verified)

`get_sales_dashboard_kpis` is now a projection with no business rules of its own.

| Figure | Canonical source |
| --- | --- |
| Revenue | posted GL via `get_account_movements` / `fetchGLTotals` |
| Receivable + aging | `finance_ar_net_position` (base currency, credit-netted) |
| Mixed-currency flag | `finance_ar_net_position_by_currency` |
| Cash applied / unapplied | `payment_allocations` vs `payments.amount` |
| Orders to fulfil | `so_line_balances.quantity_open_to_deliver > 0` |
| Quote conversion | period estimate cohort; `accepted` and `converted` are won |
| Credit notes | `credit_notes`, excluding draft/void/cancelled |
| Top customers | invoiced net of `credit_note_applications` |

Also shipped: `meta` block (as-of date, period, mixed-currency flag, per-metric
date basis) surfaced as card labels; explicit "Unavailable + Retry" state for
GL revenue failures; scope- and period-preserving drill-downs; aging cards
deep-link to `/sales/collections?aging=<bucket>` and Collections now honours
that parameter.

Guards: `src/test/architecture/sales-dashboard-projection.test.ts` (7 tests,
passing), `supabase/tests/sales_dashboard_reconciliation_test.sql`.
Docs: `docs/sales-audit.md` § Dashboard. Memory:
`mem://features/sales-overview-cockpit`.

Known limitation, accepted: the dashboard could not be visually verified in
the sandbox browser because no signed-in session is injected there; the page
redirects to login. Verification was by typecheck plus the architecture guard.

---

## Phase 4 — Purchases / Procure-to-Pay overview convergence — NOT STARTED

Apply the Phase 3 pattern to the buy side, which has the same class of drift.

1. Audit the purchases overview data lineage the same way: list every figure
   and name the engine that owns it.
2. Converge payables and aging on `finance_ap_open_items` /
   `base_residual_amount` — never document-currency `residual_amount`.
3. Converge cash out on `bill_payment_allocations`, excluding voided and
   unreconciled payments, and report unapplied vendor advances separately
   (`vendor_unapplied_advances`).
4. Converge open receiving on the PO line-balance engine rather than a
   status list, mirroring `so_line_balances`.
5. Add `meta` (as-of, period, mixed currency, per-metric date basis) and
   scope-preserving drill-downs.
6. Freeze with an architecture guard plus a SQL reconciliation contract that
   mirrors the two Phase 3 guards.

## Phase 5 — Executive dashboard reconciliation — NOT STARTED

`/dashboard` (`useDashboardAnalytics`) has not been audited. It must agree
with the Sales and Purchases cockpits figure for figure, or explicitly state
a different basis. Do not start before Phase 4 is closed.

---

## Instructions for the next agent

1. **Verify before you build.** Re-run
   `bunx vitest run src/test/architecture/sales-dashboard-projection.test.ts`
   and read `mem://features/sales-overview-cockpit`. Confirm the Phase 3
   claims above hold: `get_sales_dashboard_kpis` reads no
   `customer_credit_balances`, sums no document-currency `residual_amount`,
   and derives open fulfilment from `so_line_balances`. If a claim fails,
   fix Phase 3 before touching Phase 4.
2. **Then resume at Phase 4, step 1** — the purchases overview lineage audit.
   Do not start Phase 5, and do not open unrelated modules.
3. **Keep the invariant.** Overview surfaces are projections. A dashboard may
   never re-derive a financial figure that a canonical engine already owns.
   Every new figure needs a named source, a date basis, and a guard.
4. **Close each phase coherently** — RPC, UI, guard, docs and memory in the
   same phase — then update this file before moving on.
