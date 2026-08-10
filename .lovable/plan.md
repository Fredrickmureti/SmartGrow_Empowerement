# Purchase Requisition — Architecture Audit and Remediation Plan

## Verdict in one line

The module is a **well-behaved request form, not a procurement-demand engine**. Its lifecycle RPCs are sound; everything after "approved" is missing, and its header fields are disconnected from canonical ERP data.

## What a requisition is (enterprise principle)

A Purchase Requisition is an **internal, pre-commercial demand and spending-authorization document**. It creates *authority to procure*, never a supplier obligation, never a journal entry, never inventory. It is consumed — not replaced — by sourcing: it stays open until every requested quantity is procured, cancelled, or closed. Its currency is an *estimating* currency; the commercial currency is decided later by supplier and PO.

## Verified findings (from this codebase)

| Area | Evidence | Verdict |
|---|---|---|
| Lifecycle RPCs | `create_purchase_requisition`, `submit_requisition`, `approve_requisition`, `reject_requisition`, `cancel_requisition` — all SECURITY DEFINER, business-scoped, emit `procurement.requisition.*` outbox events | Correct |
| Self-approval | `approve_requisition` blocks `requester_id = auth.uid()` | Correct |
| Approval engine | `governance_action_registry` holds `rfq.approve`, `rfq.award`, `purchase_order.approve` — **no `requisition.submit`/`requisition.approve`**. Approval is one hardcoded step; no thresholds, no amount/cost-centre/department routing, no `approval_requests` linkage | Architecturally wrong |
| Server authority | RLS on `purchase_requisitions` is `FOR ALL ... user_has_business_access(...)`, and the only triggers are `updated_at`. Any business member can `UPDATE status='approved'` straight from the browser, bypassing every RPC | Architecturally wrong |
| Post-approval | No RPC creates an RFQ or PO from a requisition. `rfqs.requisition_id`, `rfq_items.requisition_item_id`, `purchase_orders.requisition_id`, `purchase_order_items.requisition_item_id` all exist but nothing populates them. `purchase_requisition_items.status` is seeded `'open'` and never advances; `purchase_order_item_id` is never set | Architecturally wrong |
| Partial procurement / fulfilment | No ordered/received/billed rollup; approved requisitions are a dead end | Missing |
| Amendment | Lines are freely editable after approval via the blanket RLS write policy; approval is never invalidated | Architecturally wrong |
| Currency | Column default `'USD'`, RPC default `'USD'`, form `useState("USD")` free text — ignores business base currency entirely | Architecturally wrong |
| Cost centre | `cost_center text` free text; `project_id` exists but is not exposed in the UI; no link to any accounting dimension | Architecturally wrong |
| Line model | `product_id` and `uom_id` columns exist; `RequisitionLineRow` deliberately offers no catalogue picker, so both stay null and UOM never reaches RFQ/PO/GRN | Architecturally wrong |
| Destination | No warehouse/branch destination on header or line | Missing |
| Priority | Written and displayed only; affects no routing or queue | Decorative |
| Events/email | Outbox events emitted from the RPC; no email embedded in the transaction | Correct |

## Currency — the answer

Currency is **not** a requisition input. A requisition estimates spend in the money the business keeps its books in; foreign-currency exposure is created by the *supplier*, which is unknown at requisition time.

- Header currency becomes **derived and read-only**: business base currency, displayed as context, not typed.
- Case 1 (KES business, office chairs): KES. No choice offered.
- Case 2 (KES business, USD supplier): requisition stays KES. The USD appears on the quotation and the PO; the requisition line records only the estimate.
- Case 3 (multi-currency RFQ): quotations arrive in supplier currency, are compared in a normalized currency via `exchange_rates`, and the PO carries the awarded supplier's currency. The requisition estimate is never rewritten — variance against the estimate is the buyer's control signal.

No line-level currency. No user-editable currency field.

## Target architecture

```text
Demand (manual | reorder | sales | project | asset)
  -> Requisition (draft)
  -> submit        -> approval_route (governance, threshold-driven)
  -> approved      -> released procurement demand
  -> sourcing action: RFQ  |  direct PO  |  contract/catalog call-off
  -> PO lines carry requisition_item_id
  -> GRN / Bill / Payment roll back up as fulfilment on the requisition line
  -> requisition closes only when every line is procured, cancelled or closed
```

## Remediation plan

### Phase R1 — Server authority (blocking)
- Replace the blanket `FOR ALL` RLS with `SELECT` for business members plus narrow `INSERT`/`UPDATE`/`DELETE` restricted to the requester while `status = 'draft'`; all state columns move behind the RPCs.
- Add a status-guard trigger on `purchase_requisitions` rejecting direct changes to `status`, `approved_*`, `rejected_*`, `cancelled_*`, `closed_at` outside the lifecycle functions.
- Add a line-immutability trigger: `purchase_requisition_items` writable only while the parent is `draft`.

### Phase R2 — Canonical approval
- Register `requisition.submit` and `requisition.approve` in `governance_action_registry`; add the SoD conflict pair in `governance_sod_conflicts`.
- Rewrite `submit_requisition` to call the shared `approval_route` (same pattern the RFQ domain uses), storing `approval_request_id` on the requisition; approval decisions mirror back through a trigger. Amount, cost centre, department, project and priority become routing inputs.
- Keep the existing hard SoD check as a floor.

### Phase R3 — Canonical dimensions and line model
- Replace `cost_center text` with a real dimension reference (`analytic_account_id`, alongside the existing `project_id`), backfilling the text into a legacy column; expose project and cost centre as pickers.
- Add `destination_branch_id` / `destination_warehouse_id` to the header, overridable per line.
- Make `currency` derived from the business base currency in the RPC and read-only in the UI.
- Line editor gains a product/service picker that resolves UOM, category, tax and preferred supplier; free-text lines remain legal but are flagged `is_non_catalog` and cannot be auto-converted to a stock PO without a buyer assigning a product.
- Persist requested UOM (`uom_id`) and carry it through RFQ, quotation, PO and GRN.

### Phase R4 — Procurement release and traceability
- New RPCs: `requisition_create_rfq(requisition_id, line_ids[])` and `requisition_convert_to_po(requisition_id, line_ids[], supplier_id)`, both requiring `approved` status, both stamping `requisition_id` / `requisition_item_id` on the created rows.
- Line-level procurement state machine: `open -> sourcing -> ordered -> received -> closed`, plus `cancelled`; maintained by triggers on RFQ, PO and GRN, never by the client.
- Header status derives from the lines: `approved -> partially_procured -> procured -> partially_fulfilled -> fulfilled -> closed`.
- Split procurement supported by construction: one requisition line can back several RFQ/PO lines, with an ordered-quantity rollup that cannot exceed the requested quantity.

### Phase R5 — Amendment and cancellation
- `requisition_amend` clones the approved version, bumps `version`, and returns the document to `submitted` when a material field changes (quantity, product, price beyond tolerance, cost centre, currency, need-by date beyond tolerance).
- Cancellation allowed at any pre-procured state; blocked once a line is `ordered` (cancel the PO first); always audited and event-emitting.

### Phase R6 — Workbench UI
- List page reworked into operational buckets: Drafts, Awaiting approval, Approved awaiting sourcing, Partially procured, Partially fulfilled, Overdue against need-by, Rejected, Cancelled.
- Record page gains a procurement panel (which RFQs and POs consumed which lines, with quantity rollups) and an approval-trail panel showing the governance route.
- Create form: currency shown as read-only context, cost centre and project as pickers, destination selector, product-aware line rows, per-line need-by.

### Explicitly out of scope
No journal entries. Budget/commitment consumption is deferred: the encumbrance model needs its own design pass, and there is no commitment table today.

## Technical notes

Migrations touch `purchase_requisitions`, `purchase_requisition_items`, `governance_action_registry`, `governance_sod_conflicts`, and add trigger functions plus the release RPCs. Frontend work is confined to `src/features/purchases/requisitions/*` and `src/components/documents/lines/RequisitionLineRow.tsx`. Phases R1 and R2 are prerequisites for everything else; R4 depends on the RFQ domain already rebuilt around split awards.
