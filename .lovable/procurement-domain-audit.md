# Procurement Domain — Architecture Audit & Execution Log

Live companion to `.lovable/plan.md` §"Enterprise Procurement (P2P) — Architecture Audit & Reconstruction Plan". This file tracks verified current state, drift, decisions, and phase-by-phase execution.

## Verified current state (as of handoff)

### Tables present (procurement surface)
- Sourcing: `rfqs`, `rfq_items`, `rfq_vendors`, `rfq_vendor_items`
- Orders: `purchase_orders`, `purchase_order_items`
- Receiving: `goods_receipts`, `goods_receipt_items`, `goods_receipt_discrepancies`, `inbound_shipments`, `inbound_shipment_items`
- Settlement: `bills`, `bill_items`, `bill_payments`, `bill_payment_allocations`, `bill_grn_matches`
- Returns / credits: `purchase_returns`, `purchase_return_items`, `vendor_credit_notes`, `vendor_credit_note_items`, `vendor_credit_note_applications`
- Vendor: `vendor_pricelists`, `vendor_portal_invitations`, `vendor_statements` (vendor = supplier here — shared with `contacts`)
- Landed cost: `landed_cost_bills`, `landed_cost_allocations`

### RPC surface (procurement)
`convert_rfq_to_po_atomic`, `award_rfq_atomic`, `approve_purchase_order`, `complete_goods_receipt_atomic`, `record_goods_receipt_line`, `convert_po_to_bill_atomic`, `confirm_bill_atomic`, `match_bill_to_grn`, `approve_bill`, `approve_bill_payment`, `record_multi_bill_payment`, `apply_vendor_credit_atomic`, `confirm_vendor_credit_note_atomic`, `approve_vendor_credit_note`, `allocate_landed_cost_bill`, `post_landed_cost_bill`, `reverse_landed_cost_bill`, self-approval guards, vendor↔business match guards.

WMS bridge: `_wms_auto_open_qc_on_grn`, `evaluate_crossdock_on_grn`, `tg_goods_receipt_emit_posted`.

### Structural gaps (verified absent in `pg_proc` / `information_schema`)
1. No `purchase_requisitions` — no demand layer.
2. No `suppliers` / `supplier_qualifications` / `approved_supplier_list` — supplier is a flag on `contacts`.
3. No `procurement_contracts` — only `vendor_pricelists`.
4. No `purchase_order_revisions` / `purchase_order_acknowledgements` / `purchase_order_change_orders`; no line-level PO state.
5. `goods_receipts` is single-shot (`status='completed'` terminal); no multi-delivery model; `backorders` table exists but not wired.
6. `complete_goods_receipt_atomic` writes directly to `stock_movements` + `purchase_order_items.quantity_received` + `journal_entries` — mixes Procurement, Inventory, and Finance mutation in one RPC.
7. `match_bill_to_grn` is a one-shot RPC; no `bill_match_results` state, no tolerance policy, no exception queue.
8. No `supplier_scorecards` / KPI aggregation.

### Architectural drift
- Two receive paths coexist: Procurement (`complete_goods_receipt_atomic`) and WMS (Phase 14 `receive.spec.ts` inserts GRN header directly, `create_goods_receipt` wrapper deferred as 14a.2).
- Billed-progress tracked in both `bill_grn_matches` and via `sync_po_line_billed_quantities` trigger on PO lines.
- `trg_bill_to_cost` + `trg_purchase_order_to_cost` both feed cost — needs consolidation.
- Suppliers share the `contacts` table with customers, CRM leads, and portal users — no supplier-specific domain object.

## Decisions (locked)

1. **Supplier is a first-class domain object.** New `suppliers` table is 1:1-linked to a `contacts` row via `contact_id` (contact remains the identity/address record; `suppliers` carries procurement lifecycle: category, qualification state, preferred rank, hold state, currency, incoterms, default lead time, payment terms).
2. **Every state change emits an outbox event.** Topics prefixed `supplier.*`, `procurement.*`, `sourcing.*`. Idempotency key format `<topic>:<entity_id>:<state>`.
3. **Procurement never mutates stock/GL directly** — all inventory/finance side-effects consumed via events. Current `complete_goods_receipt_atomic` will be preserved short-term but re-fronted by a canonical `create_goods_receipt` wrapper and progressively split (P7).
4. **Line-level state machines everywhere.** PR line, PO line, GR line, Bill line each carry own state and match progress.
5. **Grants in the same migration as the table.** `authenticated` gets DML, `service_role` gets ALL, `anon` is denied on all procurement tables.

## Execution log

### 2026-07-18 — P1 kickoff (Supplier Master foundation)
Landed:
- Audit doc (this file).
- Migration `procurement_p1_supplier_master`: `supplier_categories`, `suppliers`, `supplier_qualifications`, `supplier_qualification_documents`, `supplier_compliance_checks`, `supplier_bank_accounts`, `approved_supplier_list`. Full grants + RLS + updated_at triggers.
- Backfill: one `suppliers` row per `contacts` row where `contact_type = 'vendor'` OR `is_supplier = true` (idempotent).
- RPCs: `submit_supplier_qualification`, `approve_supplier_qualification`, `reject_supplier_qualification`, `suspend_supplier`, `reinstate_supplier` — all `SECURITY DEFINER`, business-scoped, outbox emit.

Deferred (next batches):
- P0 drift cleanup — split `complete_goods_receipt_atomic` and land the `create_goods_receipt` wrapper (14a.2).
- Supplier 360 UI (waits until P1 schema is in prod).
- P2 contracts, P3 requisitions, P4 sourcing extension, P5 PO lifecycle, P6 ASN, P7 GR rebuild, P8 match, P9 returns, P10 scorecards, P11 workbench UX, P12 E2E harness, P13 RLS re-audit.
