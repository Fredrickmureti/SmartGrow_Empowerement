
# Inventory Foundation — Verification + Continuation

## Phase 0 — Verification of prior engineer's work (done in this turn)

Prior artifact: `.lovable/plan.md` (audit verdicts + execution log for Step 1 "Locations & bins", Phases 1–4).

Verified directly against DB + filesystem:

| Claim | Result |
|---|---|
| ADR 0064 + 0065 present | ✅ files exist |
| 4 migrations `20260716210212` / `210630` / `210823` / `211651` | ✅ present |
| `stock_locations`, `stock_quants` tables | ✅ exist |
| `stock_movements.source_location_id` + `.destination_location_id` | ✅ exist |
| Views `v_stock_on_hand`, `v_warehouse_stock_effective`, `v_location_summary` | ✅ all 3 exist |
| `check_stock_quant_drift` RPC | ✅ exists |
| Trigger maintaining quants from movements | ✅ exists as `trg_maintain_stock_quants` (log calls it `_maintain_stock_quants` — cosmetic naming drift) |
| Quarantine → movement trigger | ✅ exists as `trg_lot_quarantine_emit_movements` (log calls it `_emit_quarantine_movements`) |
| `useStockQuants` hook | ✅ present |

Verdict on prior work: **Phases 1–4 are genuinely delivered.** The only defect is documentation drift (trigger names in the log don't match `pg_trigger`). No functional issues. `warehouse_stock` remains authoritative; quants ledger is a live shadow. Phase 5 is drift-gated (14 clean days) and correctly deferred.

Also re-confirmed the audit's ⚠ on traceability: only `pos_transaction_items` and `delivery_note_items` carry `lot_number`/`serial_number`; `invoice_items`, `sales_order_items`, `sales_return_items`, `credit_note_items` do **not** — so "which customer bought Batch A?" is unanswerable for non-POS sales today. This is the single most valuable remaining gap.

Action: update `.lovable/plan.md` with a "verification stamp" section and correct the two trigger names, so the next agent inherits accurate ground truth.

## What we execute next

Phase 5 (retiring `warehouse_stock`) is deliberately deferred until the drift gate is met. The parallel tracks listed in the log are ready. We sequence them by **enterprise-value × prerequisite depth**, not by log order:

```text
     ┌── A. Downstream lot/serial stamping ──► two-way recall ✅
Now ─┤
     ├── B. Serial-tracked inventory (schema + ledger)
     └── C. Split-transfer adoption (transit location already exists)

Then ─── D. ASN / inbound shipments (between PO and GRN)
Then ─── E. Product variants (ADR-first)
Later ── F. Import architecture split, lot genealogy, GS1 parsing
```

A, B, C are independent and each closes a ❌/⚠ from the audit. D depends on A landing so ASN lots flow into stamped downstream documents. E is large and needs its own ADR before code.

### Phase A — Downstream lot/serial stamping (closes traceability ⚠)
**Goal:** for every lot- or serial-tracked product, every outbound sales-side document line records the exact lot/serial consumed, so recall queries return real customer results.

1. ADR 0066 "Downstream lot/serial stamping contract" — one page.
2. Migration:
   - Add `lot_number text`, `serial_number text`, `packaging_id uuid` to `invoice_items`, `sales_order_items`, `sales_return_items`, `credit_note_items` (only the columns missing).
   - Add a deferrable per-row constraint trigger: for a line whose product is `is_lot_tracked` or `is_serial_tracked`, the corresponding column must be non-null at commit.
   - Extend the atomic RPCs that emit `stock_movements` from these documents (invoice confirm, sales-return post, credit-note apply) to pass the line's lot/serial through — reuse `consume_lots_atomic` where FEFO applies.
   - Backfill migration: for existing lot-tracked outbound lines, either stamp from the linked `stock_movements.lot_number` or mark as "legacy — unknown lot" (never silently null).
3. Recall view: `v_lot_downstream_consumption(lot_number)` → customer, document, quantity, timestamp.
4. Tests: pgTAP covers the constraint trigger for each of the four tables + one architecture test that every outbound RPC forwards the lot.

Explicitly out of scope in A: changing how POS stamps lots (already correct) or how goods receipts stamp lots (already correct).

### Phase B — Serial-tracked inventory (closes serials ❌)
1. ADR 0067 "Serialised inventory".
2. Migration:
   - `products.is_serial_tracked boolean not null default false`.
   - `stock_serials(serial_number, product_id, lot_number nullable, status enum{in_stock,reserved,shipped,returned,scrapped}, current_location_id, business_id, organization_id, created_at, updated_at)`.
   - Trigger on `stock_movements` for serial-tracked SKUs: reject moves without `serial_number`; maintain `stock_serials.status` + `current_location_id`.
   - `serial_number text` on the same outbound line tables as Phase A (already covered when both phases share the same migration wave).
3. UI is out of scope for this phase; only schema + engine.

### Phase C — Split-transfer adoption (closes movement engine ⚠)
Phase 4 seeded the virtual transit location and documented the convention. Now wire the transfer completion path:
1. Refactor `useWarehouses` / `useStockTransfers` completion RPC to emit:
   - `transfer_out` (source warehouse default location → business transit location) on submit.
   - `transfer_in` (transit → destination warehouse default location) on receipt.
2. Legacy single `transfer` RPC becomes a thin wrapper that fires both in one transaction — no caller change required for direct transfers, but in-transit is now a real ledger state.
3. `v_stock_on_hand` already filters transit correctly; verify `v_warehouse_stock_effective` still nets out.

### Phase D — ASN / inbound shipments (closes goods receipt ⚠)
1. ADR 0068 "Inbound shipments and ASN reconciliation".
2. New tables `inbound_shipments` (PO-linked, carrier, expected_arrival, status) and `inbound_shipment_items` (product, expected_qty, expected_lot, expected_expiry).
3. GRN wizard: if an ASN exists for the PO, prefill lines from ASN; discrepancies (`over/short/damaged`) captured on `goods_receipt_discrepancies` (new).
4. CSV upload of ASN as a pragmatic EDI-856 stand-in (real EDI is a partner project).

### Later (own ADRs, one at a time)
- Phase E: product variants (`product.template`/`product.product` split vs attribute-matrix).
- Phase F: import architecture split (Master / Identifiers / Packaging / Opening Balances / Lots / Price Lists / Suppliers).
- Phase G: lot genealogy + manufacture_date/supplier_lot_ref/CoA metadata.
- Phase H: GS1 barcode parsing + supplier-aliased identifiers.

Phase 5 (retire `warehouse_stock`) proceeds whenever `check_stock_quant_drift` has been empty for 14 consecutive days across production tenants — no user-visible work, so it is not gated on Phases A–H.

## Technical details

- **Migrations:** every new public-schema table follows the mandatory CREATE → GRANT → RLS → POLICY order. `service_role` gets full grants; `authenticated` gets scoped grants gated by `user_can_access_business` + `can_access_branch` + `user_has_module_permission(... 'inventory' ...)`.
- **Backfill safety:** all backfills are idempotent and log a row into a per-phase audit table so rollback is a single DELETE.
- **No `warehouse_stock` schema changes** in Phases A–D. The quants ledger stays a shadow until the drift gate clears.
- **No edits to `src/integrations/supabase/types.ts`** — regenerated post-migration.
- **Movement enum:** `movement_type` is already `text`, so `transfer_out`, `transfer_in`, `serial_transfer`, and future manufacturing types add without an enum migration.
- **Architecture guards:** new tests under `src/test/architecture/`:
  - `outbound-lot-stamping.test.ts` — every outbound RPC threads `lot_number` for lot-tracked products.
  - `serial-tracking.test.ts` — every insert into `stock_movements` for a serial-tracked product includes `serial_number`.
- **Documentation:** update `.lovable/plan.md` after each phase closes — the log is the handoff contract, not a scratchpad.

## First deliverable if approved

1. Verification-stamp update to `.lovable/plan.md` (corrects trigger names, adds "Phase 0 verified" section).
2. ADR 0066 + migration for Phase A (downstream lot/serial stamping), including the four column additions, deferrable constraint trigger, RPC updates, backfill, and pgTAP + architecture tests.

Nothing else changes in this first turn. Phases B and C follow in separate PRs, each with its own ADR.

---

# Execution log

## Prior work (verified 2026-07-16, agent handoff #2)

Step 1 "Locations & bins" Phases 1–4 were delivered by the previous agent
and verified against `pg_catalog` + filesystem:

- ADRs `0064-stock-locations-and-quants.md` and
  `0065-phase-4-transit-quarantine-locations.md` present.
- Migrations `20260716210212`, `210630`, `210823`, `211651` applied.
- Tables `stock_locations`, `stock_quants` created; `stock_movements`
  gained `source_location_id` + `destination_location_id`.
- Views `v_stock_on_hand`, `v_warehouse_stock_effective`,
  `v_location_summary` present.
- RPC `check_stock_quant_drift(uuid)` present.
- Triggers: `trg_maintain_stock_quants` on `stock_movements` and
  `trg_lot_quarantine_emit_movements` on `lot_quarantine` (prior log
  called these `_maintain_stock_quants` and `_emit_quarantine_movements`
  — cosmetic naming drift, no functional impact).
- Hook `src/hooks/inventory/useStockQuants.ts` present.

`warehouse_stock` remains authoritative. Phase 5 (retire it) stays gated
on 14 consecutive clean days of `check_stock_quant_drift`.

## ✅ Phase A.1 — Downstream lot/serial stamping (schema + recall view)

- **ADR:** `docs/adr/0066-downstream-lot-serial-stamping.md`
- **Migration:** `supabase/migrations/20260716214838_*.sql`
- **Delivered:**
  - `lot_number text` + `serial_number text` on `invoice_items`,
    `sales_order_items`, `sales_return_items`, `credit_note_items`
    (POS and delivery-note lines already had them).
  - Partial indexes on each new column.
  - Canonical two-way recall view `v_lot_downstream_consumption`
    unioning POS transactions, delivery notes, invoices, sales returns,
    and credit notes with `document_type`, `document_number`,
    `contact_id`, `occurred_at`, `quantity`, `business_id`,
    `organization_id`.
  - `GRANT SELECT` on the view to `authenticated` + `service_role`.
- **Zero writer change.** Additive only.
- **Verify:** `SELECT * FROM v_lot_downstream_consumption LIMIT 1` runs
  clean. Stamp a lot on a POS line → row appears immediately.

## ✅ Phase A.2 — Enforcement + RPC wiring

- **Migration:** `supabase/migrations/20260716215210_*.sql`
- **Delivered:**
  - `approve_sales_return_atomic` — copies `lot_number` /
    `serial_number` from `sales_return_items` → `credit_note_items`
    AND stamps them on the emitted `return_in` stock_movements.
  - `confirm_invoice_atomic` — forwards `lot_number` /
    `serial_number` from `invoice_items` into the auto-created
    `delivery_note_items`, so the DN completion path (which was already
    lot-aware) emits fully-stamped movements.
  - `confirm_credit_note_atomic` and `confirm_sales_order_atomic`
    unchanged — they don't emit stock movements themselves (CN is JE-only;
    SO only reserves).
  - Shared enforcement trigger `enforce_downstream_lot_stamping()` +
    `trg_enforce_lot_stamping` on `invoices`, `credit_notes`,
    `sales_returns`: when the doc transitions into a posted status
    (confirmed/sent/partial/paid/overdue for invoices; issued/applied for
    credit_notes; approved/completed for sales_returns), every line
    whose product has `is_lot_tracked = true` must have a non-null
    `lot_number` — otherwise the transition raises with hint text.
    Drafts and cancelled/rejected transitions unaffected.
  - Architecture guard
    `src/test/architecture/outbound-lot-stamping.test.ts` pins the
    propagation surface to the migration SQL.
- **Serial enforcement** intentionally deferred until Phase B ships
  `products.is_serial_tracked` — column and propagation exist today; the
  trigger just doesn't gate on serial yet.
- **Verify:** try to confirm an invoice with a lot-tracked product line
  and no `lot_number` → `ADR-0066: N line(s) reference lot-tracked
  products without lot_number.`

## ⏭ Next up — Phase A.3 (optional): UI plumbing

RPC + ledger enforcement are complete. The remaining work is UI: line
editors on invoice/credit-note/return forms must expose a
`LotPickerPopover` (already used in POS) for lot-tracked products, and
call `resolve_fefo_lots` for FEFO defaults. This is presentation-layer
only — no schema change — and should be scheduled per screen without a
blocking ADR.

## Then — Phase B: serialised inventory (ADR 0067)

Add `products.is_serial_tracked`, `stock_serials` table + status
lifecycle, movement-level serial enforcement trigger, and extend
`enforce_downstream_lot_stamping` to also check serial columns.

## Guardrails for the next agent

- Do NOT modify `warehouse_stock` triggers or drop the table until the
  drift gate is met.
- Do NOT edit `src/integrations/supabase/types.ts` — regenerated after
  each migration.
- New readers use `v_stock_on_hand` / `useStockQuants` for on-hand and
  `v_lot_downstream_consumption` for recall.
- Every new inventory-affecting table needs GRANT + RLS in the same
  migration.
- The linter's ~1800 "Security Definer View" errors are pre-existing
  project-wide noise; ignore unless the count grows on your migration.
