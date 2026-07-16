## Verification of prior work (Phase 1)

Cross-checked `.lovable/plan.md` against the tree. Everything the prior engineer marked complete is genuinely present:

- ADRs 0064–0069 all on disk (stock_locations/quants, transit/quarantine, downstream lot-serial stamping, serialised inventory, split transfers, inbound-shipments/ASN).
- Inventory architecture guards present and named as claimed: `outbound-lot-serial-ui`, `grn-serial-capture`, `grn-asn-prefill`, `asn-csv-import`, `outbound-lot-stamping`, `serial-tracking`, `inbound-shipments`, plus the branch/adjustment/dashboard guards.
- Primitives all exist: `LotPickerPopover`, `SerialPickerPopover`, `OutboundLineTracking`, `outboundLineTrackingUtils.ts`, `useProductTrackingFlags`.
- ASN backend real: `createAsnBatchImportHandler` + `ASN_IMPORT_FIELDS` in `src/lib/importConfigs/`, `inbound_shipments` referenced by GRN wizard and guards.
- GRN wizard has ASN prefill + serial capture wiring.

**Verdict: Phases 1–4, A.1–A.5, B, C, D, D.2 are real.** No shallow patches found. The two genuine gaps confirmed:

1. **Phase D.3 has no UI.** `inbound_shipments` is only referenced by the GRN wizard, the import handler, and tests — there is no page, no route, and no entry point on Purchase Orders that lets an operator import an ASN or view expected shipments. The whole ASN import pipeline is dark to end users.
2. **Edit-surface pickers.** `OutboundLineTracking` is mounted only on the four **create** pages. `InvoiceEditPage`, `CreditNoteEditPage`, delivery note edit, and sales-return edit can still author lot/serial-tracked lines without a picker, so post-time DB rejection is the only guard on the edit path.

Everything else on the deferred list (SO line editor, Phase E–H, warehouse_stock retirement) is correctly deferred and not blocking.

## Phase A.6 + D.3 — what to build now

### D.3 — ASN inbound-shipments UI (primary)

Enterprise-critical: today the ASN pipeline is invisible to operators. Deliverables:

1. **New route** `/inventory/inbound-shipments` — list view of `inbound_shipments` for the current business + branch, columns: reference, supplier, expected_date, status (`expected` / `partially_received` / `received` / `cancelled`), linked PO, linked GRN count. Server data via existing query patterns (Supabase select with joins to `contacts` + `purchase_orders`).
2. **Inbound Shipment detail page** `/inventory/inbound-shipments/$id` — header + `inbound_shipment_items` table (product, expected qty, lot, expiry), plus an action "Start Goods Receipt" that deep-links into `GoodsReceiptWizardPage` prefilled from this shipment (path already supported by the wizard's ASN prefill).
3. **"Import ASN" action** — button on both the new inbound-shipments list and the Purchase Orders index, opens the existing CSV import dialog composed from `useImport(ASN_IMPORT_FIELDS)` + `createAsnBatchImportHandler`. No new import machinery.
4. **Navigation entry** — sidebar link under Inventory → Inbound Shipments; keep purchase-orders nav intact.
5. **Architecture guard** `src/test/architecture/inbound-shipments-ui.test.ts` — asserts the new routes exist, that the list imports `inbound_shipments` reader, that the Import ASN dialog imports `createAsnBatchImportHandler` + `ASN_IMPORT_FIELDS`, and that the detail page's "Start GRN" button navigates to the GRN wizard with the shipment id in the URL contract used by the existing prefill guard.

### A.6 — Edit-path picker wiring (secondary, same turn)

Mount `OutboundLineTracking` on the four edit surfaces and route their line state through the same `onLotChange` / `onSerialChange` callbacks the create pages use. Extend the existing update-hook whitelists so `lot_number`, `serial_number`, and (for delivery notes) `lot_allocations` propagate on update, matching the insert side.

Files touched (additive — no schema, no RPC, no migrations):
- `src/features/sales/invoices/…EditPage.tsx` (or `InvoiceLineRow.tsx` already covers it — verify during implementation and only wire what's missing)
- `src/features/sales/credit-notes/CreditNoteEditPage.tsx`
- `src/features/sales/returns/SalesReturnEditPage.tsx`
- `src/features/sales/delivery-notes/DeliveryNoteEditPage.tsx`
- Update-side whitelists in `useInvoices`, `useCreditNotes`, `useSalesReturns`, `useDeliveryNotes`.

Extends `outbound-lot-serial-ui.test.ts` to pin the edit-surface mounts as well as the create-surface ones (31 → ~40 tests).

### Explicitly deferred (unchanged from prior plan)

- Sales-order line editor (SO doesn't move stock; cosmetic).
- Phase E — variants; Phase F — import file split (Product / Barcode / Batch / Warehouse Stock / Price / Supplier); Phase G — lot genealogy view; Phase H — GS1 AI parsing on scan input. Each gets its own ADR + turn.
- Phase 5 ambient — retire `warehouse_stock` after 14 consecutive empty `check_stock_quant_drift` runs.

## Success criteria

- Operator can import an ASN CSV from the UI, see the expected shipment in `/inventory/inbound-shipments`, click "Start GRN", and the wizard prefills every line with product/qty/lot/expiry from that shipment.
- All four outbound edit pages render the lot/serial picker for tracked products, and the persisted `lot_number` / `serial_number` / `lot_allocations` survive update round-trips.
- Combined inventory-foundation guard surface grows from 92 tests to ~110 tests, all green.
- No migrations, no RPC changes, no `types.ts` edits.

## Technical notes

- Route files follow the flat `inventory.inbound-shipments.tsx` + `inventory.inbound-shipments.$id.tsx` convention (TanStack Start file-based routing).
- Queries scoped by `business_id` + optional branch, following the `readOnHand` / branch-filter pattern already pinned by `inventory-branch-filter.test.ts`.
- Import dialog reuses the existing `useImport` hook — no new UI library, no new import framework.
- Edit-surface wiring is additive; if `InvoiceLineRow` already covers `InvoiceEditPage` via shared render, only the guard is extended for that surface.
