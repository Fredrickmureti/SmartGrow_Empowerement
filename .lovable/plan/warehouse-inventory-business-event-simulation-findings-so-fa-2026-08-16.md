# Warehouse → Inventory business-event simulation: findings so far, and the execution plan

I have completed the **static forensic pass** (schema, live `pg_proc` bodies, migrations, routes, architecture tests). I have **not** executed the 200-carton scenario, because running it creates test master data and posts real stock/GL rows — that is a state change, so it needs your approval first.

Below: what the implemented flow actually is, one confirmed P0 defect, and the exact execution protocol I will run once approved.

---

## A. The real implemented business-event graph

Verified against the live database (`pg_proc`, `pg_enum`, `information_schema`), not from the UI.

```text
purchase_requisitions ──(submit/approve, governance_assert_not_self)──┐
rfqs → rfq_quotations → rfq_awards ───────────────────────────────────┤
                                                                      ▼
                                purchase_orders + purchase_order_items
                                po_status: draft,submitted,approved,acknowledged,
                                           sent,partial_received,received,revised,
                                           rejected,closed,cancelled
                                                      │
              AUTHORITATIVE INBOUND EXPECTATION = purchase_order_items.quantity
                                                   (minus .quantity_received)
                                                      │
                    ┌─────────────────────────────────┴──────────────────────────┐
                    ▼ (optional ASN)                                             ▼ (direct)
       inbound_shipments + inbound_shipment_items                        wms_receiving_sessions
       draft→dispatched→in_transit→arrived→received                      open→unloading→captured→
                    │                                                    discrepant→posted→closed
                    └──────────────► wms_receiving_sessions ◄────────────────────┘
                                     (source_doc_type = purchase_order | inbound_shipment | asn)
                                                      │ wms_capture_receiving_line
                                                      │   (packaging_id + entered_qty →
                                                      │    wms_to_base_qty → received_qty)
                                                      ▼ wms_post_receiving_session
                        ┌─────────────────────────────┴─────────────────────────┐
        source=purchase_order                                    source=inbound_shipment/asn
                        ▼                                                        ▼
              create_goods_receipt                                    receive_inbound_shipment
                        ▼                                                        ▼
        complete_goods_receipt_atomic                              goods_receipt left status='draft'
          ├── wms_apply_gr_stock  → stock_movements                 NO wms_apply_gr_stock
          ├── finance_post_gr_journal → GR/NI journal               NO finance_post_gr_journal
          └── outbox procurement.gr:<id>:posted                     NO outbox event
                        ▼
              trigger _maintain_stock_quants → stock_quants (derived balance)
                        ▼
              receive_goods_to_wms (relocate to staging) → putaway tasks (wms_tasks)
                        ▼
              QC: _wms_ensure_qc_hold / accept|reject_qc_inspection (real ledger moves)
```

Classification of the warehouse surfaces you listed, for **this inbound event**:

- **Required**: Warehouses + Layout & storage (config), Packaging catalogue (config), Inbound control tower, Receiving, Putaway + Putaway strategies, Handling units, Inventory stock position.
- **Conditionally required**: Appointments (only if a dock appointment is bound), Quality inspections (only when a QC rule/hold applies), Exceptions (only on variance).
- **Not applicable**: Cross-dock, Returns, Replenishment, Cycle counts, Slotting, all Outbound (tower/wave/dispatch), all Yard (gate/marshal/trailers), 3PL billing, Labour, label printing.
- **Analytical projection only**: Work → Overview, Operations performance, both control towers (they read the underlying documents; source of truth is `purchase_order_items` / `inbound_shipments` / `wms_receiving_sessions`).

Integration verdict (static): Procurement→Warehouse is **RPC + FK driven** (`wms_receiving_sessions.source_doc_id`), Warehouse→Inventory is **RPC → `stock_movements` → trigger → `stock_quants`** (event-sourced at the ledger, not at the outbox). `business_event_outbox` is used for notification/saga, **not** as the path that moves stock.

---

## B. Confirmed defect (live DB, before any simulation)

**P0 — the ASN receiving path never posts inventory or GL.**

Evidence, queried directly against the deployed functions:

| function | calls `complete_goods_receipt_atomic` | applies stock | posts GR/NI journal | carries packaging |
|---|---|---|---|---|
| `create_goods_receipt` (PO path) | **true** | via atomic | via atomic | true |
| `receive_inbound_shipment` (ASN path) | **false** | false | false | **false** |
| `receive_goods_to_wms` | false | false | false | true |

Consequences:
1. `wms_post_receiving_session` on an ASN-sourced session returns success, transitions the session to `posted`, and **on-hand does not change** — the `goods_receipt` stays `status='draft'` forever.
2. `receive_goods_to_wms` documents that it only *relocates* a balance "the goods receipt ledger already created" — on the ASN path that balance does not exist, so the relocation is silently a no-op or an orphan.
3. Because `receive_inbound_shipment` inserts `goods_receipt_items` without `packaging_id`/`display_quantity`, the `_uom_normalize_line` trigger has nothing to normalise; the ASN path implicitly assumes base units. Feed it 200 and you book 200 packets, not 6,000.
4. A prior hand-written data fix in `20260815062923_*.sql` already zeroed a "doubled balance" for one product — i.e. this seam has caused a production correction before.

**P2 — `wms_apply_gr_stock` is `SECURITY DEFINER`, granted to `authenticated`, and idempotency is document-level only** (`goods_receipts.status='completed'` guard sits in the caller, not the writer). There is no unique constraint on `stock_movements(reference_type, reference_id, line)`. A direct RPC call double-posts.

**Not a defect (open question closed):** `po_status` *was* extended in the live DB to include `submitted, approved, acknowledged, closed, revised, rejected` — the code is consistent with the deployed enum.

---

## C. What I will execute once approved

Everything tagged `is_sample_data = true` where the column exists, and named `E2E-MILK-*`.

1. **Master data (minimum)** — reuse the canonical models only: one product "Milk 500ml" with base UOM = packet; one `product_packaging` row `Carton`, `qty_in_base_uom = 30`, `is_purchase_default = true`. Confirm `wms_packaging_types` (warehouse container catalogue) is *not* used for this, per the handling-unit invariant. One supplier contact, one warehouse with receiving-staging + quarantine + storage bins.
2. **Baseline capture** — snapshot `stock_quants`, `stock_movements`, `products.stock_quantity`, `warehouse_stock` for the product (expect zero rows).
3. **PO path (control)** — requisition → approve → PO 200 cartons (`display_quantity = 200`, `packaging_id = carton`) → verify `purchase_order_items.quantity = 6000` base authored by `a_uom_normalize_po_items`, not by the browser.
4. **ASN** — `create_inbound_shipment` + items 200 cartons → `dispatch` → `in_transit` → `arrived`. Assert **on-hand still 0** (ASN must not create stock).
5. **Inbound control tower** — verify the expectation is visible with correct supplier/PO/ASN/qty/warehouse, and that no duplicate or orphan inbound row exists.
6. **Receiving** — open a `wms_receiving_sessions` bound to the ASN, `wms_capture_receiving_line` with `packaging_id = carton, entered_qty = 200`, assert `received_qty = 6000` from `wms_to_base_qty`. Then `wms_post_receiving_session` and **expect the P0 to reproduce: session `posted`, GR `draft`, zero `stock_movements`**. Capture that as the primary evidence.
7. **Re-run through the PO-sourced branch** to prove the correct path books 6,000 packets, one `stock_movements` row with `reference_type='goods_receipt'`, `stock_quants` maintained by trigger, and a GR/NI journal — establishing that the defect is path-specific, not systemic.
8. **Putaway + handling unit** — follow `wms_tasks` to a storage bin, verify the location change is a movement and not an UPDATE; verify the carton is *packaging*, the pallet/plate is a `wms_license_plates` handling unit, and that the two are not conflated.
9. **QC** — determine from configuration whether a hold applies. If it does, verify quarantined units remain on the books but out of the available bin. If not, record "not applicable, no QC rule matches this product" rather than inventing one.
10. **Controls** — duplicate post (expect the `status='completed'` guard to reject), retry idempotency via the outbox `idempotency_key`, and a 190-carton short-receipt variance run to observe `wms_flag_receiving_variances` and `purchase_order_items.receipt_status`.
11. **Reconciliation** — prove `200 × 30 = 6,000` at every hop, and walk the audit trail backwards: `stock_quants` → `stock_movements.reference_id` → `goods_receipts` → `purchase_order_items` → `purchase_orders` → requisition/supplier. Report exactly where lineage breaks.

Deliverable: the report in your requested shape (A actual flow, B event-by-event table, C quantity reconciliation, D defects with root cause, E architecture verdict, F remediation plan in dependency order). **No fixes applied during the run** — remediation is proposed, not implemented.

---

## D. Technical notes

- Read-only introspection via `supabase--read_query`; writes via the canonical RPCs only (never raw table inserts), so governance/triggers/idempotency are exercised as a real operator would.
- No `psql`/`PGHOST` in this sandbox, so all SQL goes through the Supabase query tool.
- Tenant isolation: single business/organization, all rows prefixed `E2E-MILK-` and flagged `is_sample_data` so your workspace reset removes them.
