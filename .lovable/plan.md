# Sales Domain Wave — authoritative status

Detailed per-phase evidence lives in `docs/plans/sales-domain-live-status.md`.
This file is the wave-level snapshot: what is done, what is pending, what is
active, and what the next agent does first.

## Fully implemented and verified

| Phase | Outcome |
|---|---|
| 0 | Upstream contracts verified against the live database (not migrations). |
| 1 | Sales lifecycle / document graph, immutability and reversal map. |
| 2 | Products reach Sales only through `list_products_with_branch_stock`. |
| 3 | Line quantity contract — `resolve_line_base_quantity`, base units canonical. |
| 4 | Pricing, line tax and totals resolved server-side; header totals rewritten from lines. |
| 5 | Availability policy (`salesStockPolicy`) consumed by every line-capturing editor. |
| 6 | Invoice ↔ Receivables: governed writes, server GL resolution, atomic idempotent creation. |
| 6b | Fulfilment warehouse recorded on invoice / sales order / delivery note; availability read from that same warehouse. |
| 7 | **Sale-time tax** — `resolve_sales_line_tax` is the single authority; document-dated, validates line-level rates, refuses invented free-text rates, handles fixed-amount and inclusive rates, rejects compound, stamps `tax_rate_id` for audit. Client is preview-only. |

Verification for the current phase: `tsgo` clean; 44 architecture guard tests
passing (`sales-tax-authority`, `invoice-totals-contract`,
`sales-warehouse-selection`, `sales-availability-coverage`,
`invoice-creation-atomic`); live resolver probes for accepted, rejected and
exempt tax paths.

## Currently active phase

None in flight — Phase 7 closed cleanly. The next phase has not been started.

## Pending work, in roadmap order

1. **Phase 9 — document lifecycles.** `estimate_items` and
   `estimate_additional_costs` are still inserted and deleted directly from the
   browser. Bring them under a governed write path like their siblings
   (`trg_00_*_governed_write` + an atomic writer RPC).
2. **Phase 10 — server authority & concurrency.** `create_sales_order_atomic`
   and the converters accept no idempotency key; reuse
   `public.sales_document_idempotency`. Prove double-submit, retry, refresh and
   two-user edit behaviour.
3. **Phase 11** — multi-tenant / branch scope audit, including document
   numbering.
4. **Phases 12–14** — events on `business_event_outbox`, failure semantics,
   reporting-vs-transactional boundaries.
5. Carry-overs: route the manual product picker through the ADR 0114 identity
   seam; `process-recurring-invoices` still writes `next_run_date` itself.

## Instructions for the next agent

1. **Verify before you build.** Confirm Phase 7 actually holds in the live
   database, not in migration files:
   - `resolve_sales_line_tax` exists and `_totals_normalize_line` calls it;
   - a line-level `tax_rate_id` from another company, an inactive rate, an
     expired rate and an unconfigured free-text rate are each rejected;
   - a back-dated invoice picks up the rate in force on its `issue_date`;
   - the applied `tax_rate_id` is stamped on the saved line;
   - `bunx vitest run src/test/architecture` and `bunx tsgo --noEmit -p
     tsconfig.app.json` are clean.
   Record the verdict in `docs/plans/sales-domain-live-status.md`.
2. **Then start Phase 9** (governed writes for estimates) — not any other area
   of the system. Finish it to a production-ready state, with a guard test and
   a ledger entry, before touching Phase 10.
3. Never work around an upstream defect inside Sales: fix it in its owning
   domain, or mark the phase blocked with evidence.
4. Update `docs/plans/sales-domain-live-status.md` **and** this file at the end
   of every phase.
