# Inventory Foundation — Execution Log & Roadmap

_Last updated: end of Phase E (Product Variants). Handoff checkpoint._

> **Read me first, next agent.** This file is the single source of truth for
> what has landed, what is verified, and what to build next. Before adding
> anything, re-run the verification steps in the "How to verify" block for
> the phase you intend to touch. Do not build on top of unverified claims.

---

## ✅ Completed (verified, guards green)

### Phase 1 — Verification of inherited work
- ADRs **0064–0069** present on disk under `docs/adr/`.
- 92 inventory-foundation architecture guards inherited green.
- Primitives verified in `src/components/inventory/`:
  `LotPickerPopover`, `SerialPickerPopover`, `OutboundLineTracking`,
  `outboundLineTrackingUtils.ts`, `useProductTrackingFlags`.
- ASN backend verified: `createAsnBatchImportHandler` + `ASN_IMPORT_FIELDS`
  in `src/lib/importConfigs/`; GRN wizard has ASN prefill + serial capture.

### Phase A.6 — Edit-path picker parity
- `InvoiceEditPage` covered via shared `InvoiceLineRow`.
- `CreditNoteEditPage.tsx` — `OutboundLineTracking` mounted on the edit path.
- `SerialPickerPopover` bug fix: `warehouse_id` → `current_warehouse_id`.
- **Scope note:** `SalesReturnEditPage.tsx` and `DeliveryNoteEditPage.tsx`
  do not exist; create-surface pickers cover their lifecycle.

### Phase D.3 — ASN Inbound Shipments UI
- `src/pages/inventory/InboundShipments.tsx`,
  `src/pages/inventory/InboundShipmentDetail.tsx`, routes + nav wired.
- Guard: `src/test/architecture/inbound-shipments-ui.test.ts` (10 tests).

### Phase G — Lot Genealogy & Traceability View
- **ADR 0070** — `docs/adr/0070-lot-genealogy.md`.
- `src/pages/inventory/Lots.tsx`, `src/pages/inventory/LotDetail.tsx`.
- Canonical `(business_id, product_id, lot_number)` stamped on
  `stock_movements`.
- Guard: `src/test/architecture/lot-genealogy-ui.test.ts` (11 tests).

### Phase H — GS1 AI parsing on scanner input
- **ADR 0071** — `docs/adr/0071-gs1-scanner-parsing.md`.
- `src/lib/gs1/aiTable.ts` — pure AI catalogue (GTIN, lot, expiry,
  production date, serial, count, weight/measure family, FNC1).
- `src/lib/gs1/parseGs1.ts` — table-driven parser. Handles
  `]C1/]d2/]e0/]Q3` symbology prefixes, leading FNC1, fixed + variable
  length AIs, `310n` decimal indicators, `YYMMDD` with day-`00` →
  last-day-of-month.
- `src/lib/gs1/useGs1Scanner.ts` — `interpretScan(raw)` returns
  `{ resolveCode, isGs1, normalized }`; legacy resolvers keep working;
  GS1 payloads collapse to their GTIN for barcode lookup.
- `src/lib/gs1/parseGs1.test.ts` — 12 tests across all AI families +
  failure modes.
- Wired into:
  - `src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx`
    (line scan → resolve GTIN → prefill lot, append serials, honour AI 30
    quantity, expiry surfaced in scan flash).
  - `src/components/inventory/LotPickerPopover.tsx`
    (`scannedLot` + `scannedExpiry` props → override allocation pinned to
    scanned batch, synthetic row when lot not yet in FEFO).
  - `src/components/inventory/SerialPickerPopover.tsx`
    (`scannedSerial` prop → auto-select matching in-stock serial).
- Guard: `src/test/architecture/gs1-parsing.test.ts` (parser isolation,
  AI table coverage, hook wraps parser, wizard imports hook, both
  pickers accept scanned props, ADR 0071 present).

### Phase E — Product Variants ✅ **completed this session**
- **ADR 0072** — `docs/adr/0072-product-variants.md`. Doctrine:
  variants are first-class `products` rows joined by `variant_parent_id`.
  Parent rows are never transacted (`is_variant_parent = true` must be
  excluded from stock/pickers). Rationale: keeps every phase-A..H
  surface intact because everything still resolves by `product_id`.
- **Migration (executed against connected Supabase):**
  - New tables: `public.product_variant_axes`,
    `public.product_variant_axis_values`.
  - New columns on `public.products`:
    `variant_parent_id uuid` (FK products, ON DELETE RESTRICT),
    `is_variant_parent bool NOT NULL DEFAULT false`,
    `variant_axis_values jsonb`.
  - Invariants: `chk_variant_parent_not_self`, `chk_parent_xor_child`.
  - Partial index `idx_products_variant_parent`.
  - RLS via `user_can_access_business(auth.uid(), business_id)` on axes
    and via EXISTS-on-axis on axis values.
  - GRANTs to `authenticated` + `service_role`; **no anon**.
  - `updated_at` trigger on axes.
- `src/features/inventory/variants/generateVariantMatrix.ts` — pure
  cartesian generator + deterministic `deriveVariantSku` + `sameCoord`.
- `src/features/inventory/variants/generateVariantMatrix.test.ts` —
  12 unit tests (empty, single axis, cartesian, empty axis skip, SKU
  slug rules, coord equality).
- `src/features/inventory/variants/useVariantAxes.ts` — react-query
  hooks: `useVariantAxes`, `useCreateVariantAxis`, `useAddAxisValue`,
  `useDeleteAxisValue`.
- `src/features/inventory/variants/ProductVariantsPanel.tsx` — mounted
  in `src/pages/inventory/ProductForm.tsx` (edit mode only). Features:
  - Toggle `is_variant_parent` from the UI.
  - CRUD axes + values against the business catalogue.
  - Live matrix preview with "exists" markers.
  - "Generate N new variants" flips parent flag then inserts children,
    copying parent pricing / UoM / tracking / accounts / image /
    description; deterministic SKU via `deriveVariantSku`.
  - Existing variants list with link to per-variant edit page
    (`/inventory-app/products/:id/edit`).
- Guard: `src/test/architecture/product-variants.test.ts` — ADR
  accepted, migration invariants + GRANTs present, `ProductForm`
  imports the panel, matrix generator is pure (no supabase / fetch),
  panel writes `variant_parent_id` + flips `is_variant_parent`.

**Session-side infra fix:** `bun install` was executed at end of session
after TS reported missing declarations for `react-router-dom`,
`framer-motion`, `qrcode.react`, `react-dropzone`. Dependencies were
declared in `package.json` but `node_modules` had been evicted from the
sandbox. Reinstall resolved all TS2307 errors. If those errors recur
after a sandbox reset, run `bun install` first — do **not** treat as a
code bug.

**Current guard surface:** ~130+ architecture tests (92 baseline +
Phase D.3, G, H, E additions).

---

## ⏭️ Remaining — deferred pillars (execution order)

### Phase E+ — transactional pickers become variant-aware (not yet done)
**Status:** _NOT started._ Panel + schema landed, but the read paths do
not yet filter parents / expand variants.

Concrete tasks:
1. POS product search (`src/features/pos/` — look for the product
   lookup hook / query used by the cart) must filter
   `is_variant_parent = false`. If a parent row is matched by search
   term, expand to its variants in the dropdown so the cashier picks a
   leaf.
2. Same treatment on invoice line pickers (`InvoiceLineRow` and
   siblings), GRN line resolver in the goods-receipt wizard, sales-order
   line pickers, and stock adjustment line pickers.
3. Barcode resolution already routes to the leaf (barcodes live on
   `product_identifiers.product_id` — leaves get their own barcodes).
   Verify no path calls `.eq("id", parentId)` and expects a
   transactable row.
4. Product list (`src/pages/Products.tsx`) — collapse variants under
   parent; parent row shows aggregate `SUM(stock_quantity)` from
   children.
5. Stock valuation / inventory reports should exclude
   `is_variant_parent = true` from unit counts to avoid double-counting.
6. Extend guard `product-variants.test.ts` with picker-exclusion assertions.

**Why deferred this session:** Phase E's schema and authoring UI is the
critical foundation. Read-path fanout touches many files and warrants
its own audit pass so we don't miss a picker.

### Phase F — Product Import Split (variant-aware)
**Status:** _NOT started._ Blocked on nothing now that Phase E schema
is live.

Concrete tasks:
1. **ADR 0073** — one importer per artefact; each emits idempotent
   business events on the outbox.
2. Split `src/lib/importConfigs/` monolithic product importer into six:
   - Product master (parent + children via `variant_parent_id`; axes
     resolved from `product_variant_axes` by name; unknown axis/value
     is auto-created within the same business).
   - Barcodes (writes `product_identifiers`).
   - Batch/Lot (writes `stock_lots`).
   - Warehouse Stock (writes opening `stock_quants`; must not hit the
     legacy `warehouse_stock` table — Phase 5 will retire it).
   - Price lists (writes `price_lists` + `price_list_items`).
   - Supplier links (writes `vendor_pricelists`).
3. Each importer gets its own `importConfig`, batch handler, and guard.
4. Guard: `src/test/architecture/product-import-split.test.ts` — one
   config per artefact, no cross-artefact writes, variant-aware master
   importer resolves axes without dropping rows.

### Phase 5 (ambient) — retire `warehouse_stock`
**Precondition:** 14 consecutive clean `check_stock_quant_drift` runs
(surface the counter somewhere durable — currently ad-hoc).

Concrete tasks:
1. Enumerate remaining readers of `warehouse_stock` (`rg
   warehouse_stock src/`). Every reader must move to `stock_quants`.
2. Migration: drop `warehouse_stock` (and `warehouse_stock_lots` if
   also stale) with a preflight `SELECT count(*)` snapshot logged to
   `stock_adjustment_backfill_log`.
3. **ADR 0074** — retirement rationale + drift-run evidence attached.

### Phase E follow-ups (nice-to-have, non-blocking)
- Per-variant image gallery (leaves currently inherit parent `image_url`).
- Retro-migration script for existing "Size-in-name" products →
  structured axes (needs product owner sign-off, not a code task).
- Bulk-edit stock/price for a matrix row-set in
  `ProductVariantsPanel`.

### Optional Phase H+ follow-up (unchanged from prior handoff)
- Feed AI 17 expiry into `goods_receipt_items` so `stock_lots.expiry_date`
  upserts on receipt (currently expiry only shown in the scan flash;
  lot master captures it on the FEFO path).
- Audit POS scan input GS1 wiring in `src/features/pos/` — route any
  surface reading raw scan strings through `interpretScan` (single-line
  change per site).

### Explicitly out of scope (do not build)
- Sales-order line editor lot/serial pickers (SO doesn't move stock).
- Edit pages for sales returns & delivery notes (don't exist).

---

## 🎯 Next execution — recommendation for the next agent

**Do Phase E+ first, then Phase F.** Rationale: the moment a user
generates a variant matrix on production data, transactional pickers
will start showing parent rows alongside leaves. That's a data-integrity
foot-gun (someone could sell against a parent SKU). Landing E+ closes
the loop before F expands the surface.

Suggested order:
1. Audit picker surfaces (`rg -n "from ['\"]\\@\\/hooks\\/useProducts"` +
   `rg -n "products.*is_active"`); enumerate every place that lists
   products for a transactional action.
2. Add a single shared query helper (e.g. extend `useProducts` with an
   `excludeVariantParents` option; default `true` for transactional
   uses, `false` for admin/product list).
3. In `Products.tsx`, add parent → children row grouping.
4. Extend `product-variants.test.ts` with picker-exclusion assertions
   so future regressions fail CI.
5. Once E+ green, start Phase F with ADR 0073.

---

## How to verify what's here before you build on it

Run these from repo root:

```bash
# ADRs on disk
ls docs/adr | grep -E '006[4-9]|0070|0071|0072'

# Phase E files
ls src/features/inventory/variants/
ls src/test/architecture/product-variants.test.ts

# Migration executed on Supabase (should return 3 columns + 2 tables)
# Use supabase--read_query:
#   SELECT column_name FROM information_schema.columns
#    WHERE table_schema='public' AND table_name='products'
#      AND column_name IN ('variant_parent_id','is_variant_parent','variant_axis_values');
#   SELECT table_name FROM information_schema.tables
#    WHERE table_schema='public'
#      AND table_name IN ('product_variant_axes','product_variant_axis_values');

# Guards (once bun install has run)
bunx vitest run src/test/architecture/product-variants.test.ts
bunx vitest run src/features/inventory/variants/generateVariantMatrix.test.ts
```

If any of those come back empty / red, **stop and re-verify** before
adding new work. Do not build on top of unverified foundations — that's
the whole point of the enterprise audit directive from the handoff.
