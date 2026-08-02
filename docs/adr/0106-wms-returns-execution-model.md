# ADR 0106 — WMS Returns (RMA) execution model

Status: Accepted (2026-08-02)
Depends on: ADR 0079 (Inventory vs Warehouse split), ADR 0101 (WMS domain, FSM &
event catalog), ADR 0084 (document artifacts), ADR 0085 (rendering ownership).

## Context

Returns touch three domains at once: physical execution (unload, inspect,
disposition), inventory (restock / quarantine / scrap movements), and finance
(credit note or vendor debit). Before this ADR the boundary was implicit —
page code could in principle update return state directly and build its own
paperwork, and the credit-note back-link from Finance was manual.

## Decision

### 1. Returns are an execution aggregate owned by Warehouse

`wms_return_orders` (header) and `wms_return_lines` (units) are the canonical
tables. State lives in `wms_return_state` and is written **only** by
`wms_transition_return`; every mutating path is a `SECURITY DEFINER` RPC that
takes `p_row_version` for optimistic concurrency:

| Concern | RPC |
|---|---|
| Header FSM | `wms_transition_return` |
| Line capture | `wms_capture_return_line` |
| Inspection | `wms_inspect_return_line` |
| Disposition posting | `wms_post_return_dispositions` |
| Closure | `wms_close_return` |
| Finance handoff | `wms_create_return_finance_doc`, `wms_link_return_finance` |

Direct client writes to the two tables are forbidden and guarded by
`src/test/architecture/wms-returns-guards.test.ts`.

### 2. Inventory effects are posted, never implied

Posting dispositions is the single moment stock moves. It fans out restock,
quarantine and scrap movements plus any follow-up tasks, stamps `posted_at`
per line, and is idempotent per line. A return cannot close while a
dispositioned line is unposted.

### 3. Finance is downstream and reconciles back

`wms_create_return_finance_doc` raises the customer sales return / vendor debit
once every line is dispositioned and posted. Finance then issues the credit
note in its own time; a trigger on `credit_notes`
(`_wms_backlink_return_credit_note`) writes `credit_note_id` back onto the RMA,
bumps `row_version` and emits `warehouse.return.finance_linked`. Warehouse
never computes value; Finance never writes return state.

### 4. Paperwork has exactly one exit

Four document kinds — `wms.rma_authorization`, `wms.return_receipt`,
`wms.inspection_report`, `wms.damage_report` — are built as snapshots by
`src/services/documents/snapshots/wmsReturn.ts` and dispatched by
`dispatchReturnDocument()` (snapshot → `document_records` →
`printDocumentIntent`). Returns paperwork is **quantity-only**: no prices, no
tax, no bank details. `wms_seed_returns_document_templates(org, business)`
seeds the four matching `document_templates` rows with those flags off so the
renderer never falls back to an invoice-shaped layout.

### 5. The console is a split pane, not a drawer

`/warehouse-app/returns` is a two-pane console: lanes + queue on the left, the
full execution workspace (FSM actions, lines, posting gate, paperwork, finance
handoff, event trail) on the right. Operators keep the queue in view while
working a return.

## Consequences

- New returns behaviour is added as an RPC plus a hook, never as a table write.
- Any new returns document kind must be added to `SOURCE_DOC_TYPE` **and** to
  the seed function, or the guard test fails.
- Credit-note linkage requires no operator action and is idempotent.

## Non-goals

- No valuation or GL posting inside Warehouse.
- No change to POS returns, which remain a Sales-side flow.
