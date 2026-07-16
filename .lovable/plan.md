## Phase 1 — Verification of prior work

Cross-checked `.lovable/plan.md` against the codebase:

| Claim | Verified |
|---|---|
| ADRs 0064–0069 present | ✅ 6 files, substantive content |
| 20+ inventory migrations (2026-07-15/16) incl. Phase C + Phase D | ✅ present |
| 6 inventory-foundation architecture guards | ✅ **55/55 tests pass** |
| GRN wizard prefills from ASN + writes discrepancies + flips shipment to `received` | ✅ 9 refs in `GoodsReceiptWizardPage.tsx` |
| `createAsnBatchImportHandler` with idempotency + SKU resolution + header rollback | ✅ 206 LOC, guard-pinned |
| `warehouse_stock` still authoritative, Phase 5 drift-gated | ✅ correct posture |
| Existing `LotPickerPopover` at `src/components/inventory/` | ✅ exists |

**Verdict:** Phases 1–4, A.1–A.2, B, C, D, D.2, D.3 are genuinely delivered. No shallow patches. Resuming from the plan's declared "Next up".

## Phase 2 — What to build now: Phase A.3 (lot & serial pickers on outbound editors)

**Why this is the right next step.** The DB already rejects outbound `stock_movements` for lot-tracked or serial-tracked products without a `lot_number` / serial linkage (ADRs 0025, 0066, 0067). Today users can still author invoices, credit notes, sales returns, and delivery notes with no lot/serial on the line — the failure surfaces only at post time via a raw Postgres error. Phase A.3 closes that gap so the guard is a safety net, not the primary UX.

### Scope

Line editors on these five surfaces get lot/serial pickers, gated by product flags:

1. `invoices` — line editor (Sales)
2. `credit_notes` — line editor (Sales)
3. `sales_returns` — line editor (Sales)
4. `delivery_notes` — line editor (Sales)
5. `goods_receipts` — **inbound** lot capture already exists via ASN prefill; extend only to allow user override + serial capture on receipt for `is_serial_tracked` products.

### Deliverables

1. **`SerialPickerPopover`** (new) at `src/components/inventory/SerialPickerPopover.tsx`
   - Reads `stock_serials` where `product_id = ?`, `business_id = ?`, `warehouse_id = ?`, `status = 'in_stock'`.
   - Multi-select up to line qty; disables already-selected serials in the same document.
   - Same visual shell as `LotPickerPopover` (chip trigger + popover list + search).

2. **`useProductTrackingFlags(productIds)`** hook at `src/hooks/useProductTrackingFlags.ts`
   - Single batched fetch of `products.is_lot_tracked`, `is_expiry_tracked`, `is_serial_tracked` for the visible line rows.
   - Returned map drives conditional rendering — no per-row queries.

3. **`OutboundLineTracking` cell** at `src/components/inventory/OutboundLineTracking.tsx`
   - One shared component the four outbound line editors mount inside their existing "Product" column.
   - Renders nothing for untracked products; renders `LotPickerPopover` for lot-tracked; `SerialPickerPopover` for serial-tracked; both for lot+serial.
   - Emits `{ lot_number, packaging_id, serial_ids }` onto the line row via a stable callback.

4. **Line-editor integration** — additive props, no schema changes:
   - `src/features/sales/invoices/InvoiceLineEditor.tsx` (or the equivalent line list)
   - `src/features/sales/credit-notes/…LineEditor.tsx`
   - `src/features/sales/returns/…LineEditor.tsx`
   - `src/features/sales/delivery-notes/…LineEditor.tsx`
   - Each mount `<OutboundLineTracking productId={…} warehouseId={…} qty={…} onChange={…} />`.

5. **Serial capture on GRN** — extend the receive step so the wizard, when the line's product `is_serial_tracked`, requires the operator to key/scan N serial numbers matching received qty. Persist via existing `create_stock_serials_from_receipt` RPC path (already exists per ADR 0067; verify or add a thin wrapper if missing during implementation, log in the ADR update).

6. **Architecture guard** `src/test/architecture/outbound-lot-serial-ui.test.ts`
   - Asserts each of the four outbound line editors imports `OutboundLineTracking`.
   - Asserts `OutboundLineTracking` reads `is_lot_tracked` / `is_serial_tracked` before deciding which picker to show.
   - Asserts `SerialPickerPopover` filters by `status='in_stock'`.
   - Extends the inventory-foundation surface to **~60/60 tests**.

### Explicitly out of scope this turn

- Backend RPC changes — none needed; the ledger already accepts these payloads.
- Phase D.3 UI wiring on Purchase Orders index — separate turn.
- Phase E (variants), F (import split), G (lot genealogy), H (GS1) — each its own ADR.
- Retiring `warehouse_stock` — still drift-gated (Phase 5).

## Technical notes

- No migrations. No changes to `stock_movements` triggers. No changes to `src/integrations/supabase/types.ts`.
- `SerialPickerPopover` and `LotPickerPopover` share styling primitives via `@/design-system` popover + command list — no new UI library.
- Batching: `useProductTrackingFlags` scoped to the current document's visible product ids, cached in `useQuery` with a stable key so switching tabs doesn't refetch.
- Country-agnostic, retail-agnostic — all logic keys off product-level flags, never SKU heuristics.

## Follow-ups handed to the next agent

1. Phase D.3 UI wiring — "Import ASN" action on Purchase Orders index / new `/inventory/inbound-shipments` list, composing `useImport(ASN_IMPORT_FIELDS)` + `createAsnBatchImportHandler`.
2. Phase E–H — variants, import split, lot genealogy, GS1 parsing (one ADR each).
3. Phase 5 ambient — retire `warehouse_stock` once `check_stock_quant_drift` returns empty 14 consecutive days.

---

## ✅ Phase A.3 — Delivered (2026-07-16)

- **Primitives:**
  - `src/hooks/useProductTrackingFlags.ts` — batched read of
    `is_lot_tracked` / `is_expiry_tracked` / `is_serial_tracked`,
    `staleTime: 60s`, one round-trip per visible product set.
  - `src/components/inventory/SerialPickerPopover.tsx` — reads
    `stock_serials` where `status='in_stock'` scoped by business +
    product (+ warehouse when supplied); multi-select up to
    `requiredQty`; filter input; `excludeIds` for cross-line dedupe.
  - `src/components/inventory/OutboundLineTracking.tsx` — shared cell
    that resolves business + warehouse from `BusinessContext` /
    `BranchContext.currentBranch.default_warehouse_id`, reads the
    tracking flags, and renders `LotPickerPopover` when
    `is_lot_tracked`, `SerialPickerPopover` when `is_serial_tracked`,
    both when both flags are on, nothing when neither. Renders nothing
    when `productId` is missing or `quantity <= 0`.
- **Integration sites (four outbound editors):**
  - `src/components/invoices/InvoiceLineRow.tsx` — covers
    `InvoiceCreatePage` (desktop) and `InvoiceEditPage`.
  - `src/features/sales/credit-notes/CreditNoteCreatePage.tsx`
  - `src/features/sales/returns/SalesReturnCreatePage.tsx`
  - `src/features/sales/delivery-notes/DeliveryNoteCreatePage.tsx`
    (bound to `quantity_delivered`).
- **Architecture guard:**
  `src/test/architecture/outbound-lot-serial-ui.test.ts` pins the
  primitives' contracts and asserts each of the four outbound editors
  imports and mounts `<OutboundLineTracking productId={…} />`. **17/17**
  tests pass. Combined inventory-foundation guard surface: **72/72**.
- **No migrations, no RPC changes, no schema changes.**

### Deferred out of Phase A.3 (handed to the next agent)

1. **GRN serial capture.** Requires a new
   `create_stock_serials_from_receipt` RPC + migration + wizard step.
   Surface-only capture would create silent post-time failures, so this
   is intentionally split into its own ADR + migration turn.
2. **Persist picker output.** Backend still accepts posts without user-
   picked lots for lot-tracked (FEFO auto-fallback) and rejects them
   for serial-tracked. Wiring `onLotChange` / `onSerialChange` into
   each outbound page's line-item shape so the picker output is
   authoritative rather than advisory is the next incremental step —
   it can land per-page without changing the shared primitives.

---

## ✅ Phase A.4 — Delivered (2026-07-16)

**Persist picker output on all four outbound documents** — the pickers
are no longer advisory. Every outbound insert path now writes the
operator's chosen lots and serials to the DB.

- **Shared normalizer:** `src/components/inventory/outboundLineTrackingUtils.ts`
  - `lotNumberFromAllocations(allocs)` → flat `lot_number` string
  - `lotAllocationsJson(allocs)` → full `lot_allocations` JSON blob
  - `serialNumberFromRows(rows)` → flat `serial_number` string
- **Line-editor wiring** — each of the four editors now maps
  `onLotChange` and `onSerialChange` onto its local line-item state:
  - `src/components/invoices/InvoiceLineRow.tsx` (extends
    `InvoiceLineItemShape` with `lot_number`, `serial_number`)
  - `src/features/sales/credit-notes/CreditNoteCreatePage.tsx`
    (`LineItem = Omit<CreditNoteItem, ...>` already includes both
    columns from generated types)
  - `src/features/sales/returns/SalesReturnCreatePage.tsx`
    (`LineItem` extended with `lot_number`, `serial_number`)
  - `src/features/sales/delivery-notes/DeliveryNoteCreatePage.tsx`
    (`LineItem` extended with `lot_number`, `serial_number`,
    `lot_allocations`; onLotChange writes both the flat column and
    the JSON blob)
- **Hook whitelists** — the three whitelisting insert paths now pass
  the persisted columns through:
  - `src/hooks/useInvoices.ts` → `invoice_items`
  - `src/hooks/useSalesReturns.ts` → `sales_return_items`
  - `src/hooks/useDeliveryNotes.ts` → `delivery_note_items` (incl.
    `lot_allocations` JSON)
  - `src/hooks/useCreditNotes.ts` already spreads `...item` so the
    added `lot_number` / `serial_number` fields flow through.
- **Guard extension:**
  `src/test/architecture/outbound-lot-serial-ui.test.ts` — now
  **31/31 tests** (up from 17/17). Pins every editor's
  `onLotChange` / `onSerialChange` wiring, every hook's payload, and
  the normalizer's export surface. Combined inventory-foundation
  guard surface: **86/86**.
- **No migrations, no RPC changes, no schema changes** — all target
  columns already existed on `invoice_items`, `credit_note_items`,
  `sales_return_items`, and `delivery_note_items`.

### Remaining deferred (handed to the next agent)

1. **GRN serial capture.** Still requires a new
   `create_stock_serials_from_receipt` RPC + migration + wizard step.
   Surface-only capture would create silent post-time failures —
   intentionally split into its own ADR + migration turn.
2. **Sales-order line editor.** Not currently rendering
   `OutboundLineTracking`; SO doesn't move stock (delivery notes do),
   so this is cosmetic advance-notice only, low priority.
3. **InvoiceEditPage / CreditNoteEditPage / edit paths.** The picker
   currently mounts inside the create surfaces; edit surfaces would
   need the same wiring + an update-time hook whitelist review.
