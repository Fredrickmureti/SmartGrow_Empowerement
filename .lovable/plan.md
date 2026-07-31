# Product Identification Architecture — Live Roadmap & Status Ledger

Authoritative status for the Product Identification programme (identifier registry across ERP / WMS / POS).
Reference design rationale: `.lovable/plan/product-identification-architecture-audit-consolidation-2026-07-31.md`.

**Currently active phase: C — module cutover to the shared resolver.**
Phases A and B are implemented; A/B verification evidence is listed below and must be re-confirmed before C work begins.

---

## Status ledger

| Phase | Scope | State |
| --- | --- | --- |
| A | Canonical identity model + shared resolver RPCs | Implemented — pending independent verification |
| B | Level-aware Barcode Enrollment workspace | Implemented — pending independent verification |
| C | Module cutover (WMS, GRN, purchasing, labels) | **Active — not started** |
| D | Drop legacy columns/paths, ADR-0090, guard tests | Pending (blocked by C) |

---

## Phase A — canonical model (implemented)

Delivered in migration `supabase/migrations/20260731232229_*.sql`:

- `product_identifiers.packaging_id → product_packaging(id)`, `NULL` = base unit; many identifiers per level.
- Trigger `trg_product_identifier_packaging_guard` — identifier and packaging row must share product + business.
- Backfill from legacy `product_packaging.barcode_id` and from loose `pack_quantity`; unmatched factors materialise a real packaging row instead of keeping a loose number.
- `product_identification_waivers` table + RLS — "intentionally not identified at this level" as a recorded decision.
- RPC `resolve_product_identity(business, code)` → product, packaging level, qty in base UoM, matched kind.
- `pos_resolve_barcode` delegates to the resolver; POS pricing / weighted-barcode behaviour unchanged.
- RPC `product_identification_status(business, product_ids[])` → per-product packaging ladder with per-level state.
- `enroll_product_barcode` is packaging-aware; `waive_product_identification` added.

Still additive by design: no legacy column has been dropped, every pre-existing reader still works.

## Phase B — enrollment lifecycle workspace (implemented)

- `src/hooks/inventory/useIdentificationQueue.ts` — level-centric queue over `product_identification_status`.
- `src/hooks/inventory/useEnrollmentWorkflow.ts` — `EnrollmentTarget` (product + level), `waive` action.
- `src/pages/inventory/BarcodeEnrollment.tsx` — packaging ladder badges, per-level scan cursor and instructions, `W` = no code at this level, `Esc` skip, `F` flag.

Known residue to clear in Phase D: `src/hooks/inventory/useProductsAwaitingBarcode.ts` still exists and is still referenced by `src/test/inventory/enrollment-workflow.test.tsx`.

## Phase C — module cutover (ACTIVE, next work)

Goal: no module resolves a scanned code on its own. Order of execution is fixed; finish each step to a production-ready state (UI + write path + test) before starting the next.

- **C1 — shared client resolver hook.** One hook wrapping `resolve_product_identity` (product, packaging level, qty in base UoM, matched kind, GS1 payload), with a single not-found / ambiguous-code contract and offline behaviour defined once.
- **C2 — WMS receiving.** `src/pages/warehouse/ReceivingSessions.tsx` currently drops `resolveCode` into a toast string. Replace with the C1 hook so a scanned case posts `qty_in_base_uom` base units against the resolved product, and an unknown code blocks the line instead of being narrated.
- **C3 — GRN wizard + put-away, picking, counts.** Same hook, same conversion semantics, same unknown-code contract across every scan surface.
- **C4 — purchasing.** Supplier identifiers resolve at receiving; supplier code + packaging level together drive received quantity.
- **C5 — label printing.** `src/services/printing/labelBarcode.ts` / `useLabelPrint` become level-aware: a case label prints the case identifier, never the base GTIN, and still refuses rather than falling back to an internal ID (ADR-0089 stays intact).

Each step lands with a regression test; C2–C5 each need at least one guard asserting the module calls the shared resolver rather than reading `product_identifiers` directly.

## Phase D — remove the drift (pending)

- Drop `product_packaging.barcode_id` and `product_identifiers.pack_quantity`; remove all reads/writes (`ProductPackagingEditor`, `ProductIdentifiersEditor`, `PackagingSelect`, `useProductDetailData`, `productBarcodeImportConfig`, POS barcode settings, offline bridge).
- Delete `useProductsAwaitingBarcode` and migrate `src/test/inventory/enrollment-workflow.test.tsx` onto `useIdentificationQueue`.
- Retire the legacy `products.barcode` column from the Electron SQLite schema; the offline cache mirrors `product_identifiers`.
- ADR-0090 recording the identity contract, plus architecture guards so the old shapes cannot return.

---

## Instructions for the next agent

1. **Verify before you build.** Do not start C1 until Phase A and B are independently confirmed:
   - Read migration `20260731232229_*.sql` end to end. Confirm every new table has explicit `GRANT`s, RLS enabled, and policies; confirm the RPCs are `security definer` with `set search_path = public` where they cross RLS; confirm `resolve_product_identity` and `product_identification_status` are business-scoped and cannot leak across tenants.
   - Confirm the backfill left no `product_identifiers` row with a `pack_quantity` that disagrees with its `packaging_id` factor, and no packaging level bound to an identifier of another product.
   - Confirm `pos_resolve_barcode` still returns the same shape and the same weighted/priced-barcode behaviour as before delegation.
   - Exercise the enrollment workspace end to end (queue → scan → waive → next level) and run the inventory/architecture test suites. Record what you verified in this file.
   - If verification fails, fix Phase A/B first. Do not layer C on a defective model.
2. **Then resume at C1**, and work C1 → C5 in order. Phase D is blocked until every reader has moved.
3. **Do not** start unrelated work (WMS Phase 6 backlog, billing, returns) while C is open, do not leave a scan surface half-cut-over, and do not drop a legacy column before its last reader is gone.
4. Update this ledger as each step closes: move the item to implemented, note the files/migrations, and re-point "currently active phase".
