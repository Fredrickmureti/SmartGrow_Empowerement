# Purchase Order Domain — Takeover Audit & Remaining Convergence

## Reconciliation of the previous agent's plan (verified against code + live DB)

The previous plan (`purchase-order-domain-audit-findings-and-convergence-plan-2026-08-11`)
had 5 stages. Verified status of every item:

### Stage 1 — Retire the client-side lifecycle — MOSTLY DONE
- DONE: `usePurchaseOrders` routes every transition through the state-machine RPCs
  (`runTransition` + thin wrappers for submit/approve/reject/release/acknowledge/cancel/revise/close).
- DONE: Vendor portal live bug fixed — `VendorPODetail` calls `acknowledge_purchase_order`;
  the RPC now accepts the supplier's portal user (`contacts.portal_user_id`) with SoD applied
  to internal users only (verified function body).
- DONE: Full 11-value `po_status` enum surfaced on the list page — pipeline, badges,
  filters, totals (`src/pages/PurchaseOrders.tsx`).
- DONE: `updatePurchaseOrder` strips `status` with a console warning; no raw status
  writes remain anywhere in `src/` (swept).
- DONE (takeover): `src/test/architecture/po-status-single-writer.test.ts` bans raw
  `purchase_orders.status` writes and direct `purchase_order_items` deletes.

### Stage 2 — `procurement.po.*` event consumers — DONE, one shallow piece
- DONE (verified live): `business_event_subscriptions` now routes
  `procurement.po.released` → `wms_po_ensure_expected_inbound` (warehouse) +
  `notify_po_supplier_release` (notifications); `procurement.po.cancelled` /
  `procurement.po.revised` → `wms_po_withdraw_expected_inbound`.
- DONE: `release_purchase_order` row-locks, checks business access, replays
  idempotently, emits the outbox event, and fans out synchronously to the domain
  consumers (mirrors the shipped `complete_goods_receipt_atomic` pattern).
- DONE: all three handlers are idempotent (one open ASN per PO; one email outbox row
  per PO; withdrawal only touches open ASNs).
- DONE (takeover): branded `renderPurchaseOrderEmail` wired into
  `flushEmailOutbox.renderEmail` (PO number, order/expected dates, currency, total,
  acknowledgement instructions).

### Stage 3 — Inventory expected supply — PARTIAL
- DONE: `inventory_expected_supply` view is live and correct (statuses
  approved/sent/acknowledged/partial_received, ordered − received, grouped by
  org/business/branch/warehouse/product, earliest expected date).
- DONE (takeover): `useProductDetailData`'s incoming figure now reads the view
  (replacing divergent draft-inclusive math), and `run_replenishment_planning` was
  aligned to the same view — one committed-supply definition everywhere.

### Stage 4 — Correctness hardening — PARTIAL
- DONE: `approve_purchase_order(p_po_id, p_client_request_id)` idempotency, client
  passes a stable key; `release_purchase_order` replays idempotently.
- DONE: `trg_products_service_never_tracks_stock` — service products can never track
  stock (verified trigger body; live data already consistent).
- DONE (takeover): `update_po_items_atomic` hardened — auth, business access, and a
  draft/revised/rejected status guard. Also fixed a live defect found during the work:
  it inserted into a nonexistent `received_quantity` column (real column is
  `quantity_received`) and dropped `packaging_id` / `display_uom_id` /
  `display_quantity`, so edit-page saves would have failed or silently lost data.
- DONE (takeover): `trg_po_commercial_fields_immutable` blocks commercial-header
  mutation (vendor, totals, currency, dates, number) outside draft/revised/rejected;
  notes/references stay writable; lifecycle RPCs unaffected.
- DONE (takeover): `PurchaseOrderEditPage` guards on load — non-editable statuses get
  an explanation and a path back to the record page (blocking view instead of a toast
  redirect; same guard semantics).
- DONE (takeover): `_emit_po_outbox` idempotency keys are occurrence-aware via
  `updated_at`.

### Stage 5 — Documentation — PARTIAL
- DONE: `docs/audit/procurement-verdict.md` rewritten to reflect the findings.
- DONE (takeover): ADR-0102 written (state machine ownership, event fan-out,
  expected-supply boundary, immutability rule, idempotency).

### Tests — DONE (takeover)
- `supabase/tests/po_lifecycle_convergence_test.sql`: submit→approve→release→revise,
  approve/release replay, ASN created exactly once, single email outbox row,
  withdrawal on revise, SoD on acknowledge, items guard, commercial immutability,
  occurrence-aware keys, plus introspection checks (view wiring, trigger, RPC guard).
- `src/test/architecture/po-status-single-writer.test.ts` (vitest) — see Stage 1.
- Baseline confirmed: `purchases-po-snapshot` + `po-billed-quantity-single-writer`
  pass. The 2 failing architecture files (`purchases-branch-scope`,
  `purchases-branch-id-stamping`) are the pre-existing branch-scoping violations in
  unrelated hooks the previous agent flagged — not PO-lifecycle regressions.

### Live data state
0 purchase orders, 0 `procurement.po.*` outbox rows, 0 inbound shipments — no live
flow to observe; all verification above is code- and schema-level, which makes the
missing DB tests the only way to prove the flow end-to-end.

## Remaining work (this takeover)

Ordered so each wave is shippable and reversible. No new event, governance, or
document engine — all three exist and are correct.

### Wave A — Server-side immutability of a released PO (correctness, highest value)
1. Migration: add a status guard to `update_po_items_atomic` — refuse unless the PO
   is `draft`/`revised`/`rejected` (the same set the UI treats as editable).
2. Migration: trigger on `purchase_orders` blocking mutation of commercial header
   fields (vendor, currency, expected_date, totals, delivery fields) unless the PO
   is in an editable status. Status/reason/audit columns stay writable so the
   lifecycle RPCs are unaffected.
3. Client: `PurchaseOrderEditPage` guards on load — non-editable status redirects
   back to the record page with an explanatory toast.

### Wave B — Consume expected supply
4. `useInventoryExpectedSupply` hook over the existing view, exposed alongside
   on-hand/reserved on the product inventory surface (and replenishment where it
   already reads availability). View + generated types already exist; no new
   quantity model.

### Wave C — Supplier release email quality
5. Proper `purchase_order_released` renderer in `flushEmailOutbox.renderEmail`
   (PO number, vendor name, order/expected dates, currency, total — branded layout
   consistent with the existing inventory renderer). No new email infrastructure.

### Wave D — Tests
6. Architecture test banning raw `purchase_orders.status` writes from `src/`
   (mirror `journal-posting-monopoly.test.ts`).
7. `supabase/tests/po_lifecycle_convergence_test.sql`: submit→approve→release→
   acknowledge→close; approve replay with the same `client_request_id`; double
   release; ASN created exactly once on release; single email outbox row;
   withdrawal on cancel and on revise; `update_po_items_atomic` guard;
   header-immutability trigger.

### Wave E — Documentation
8. PO ADR in `docs/architecture/decisions/` (state machine ownership, event fan-out,
   expected-supply boundary, immutability rule) and tidy the `_emit_po_outbox`
   idempotency key while touching it.

## Out of scope (explicitly)
- The pre-existing `purchases-branch-scope` / `purchases-branch-id-stamping`
  failures across unrelated hooks (separate branch-isolation workstream).
- Purchase commitment / encumbrance into budgets (previous audit: flagged,
  not scheduled — acceptable).
- Live end-to-end event flow: no PO data exists; DB tests in Wave D substitute.

## Technical notes
- All lifecycle RPCs are SECURITY DEFINER and perform their own row locks; the
  Wave A trigger must only guard commercial columns so it cannot block them.
- `business_event_outbox` has unique indexes on `idempotency_key` — event emission
  is replay-safe today.
- The `po_status` enum has 11 values; `confirmed` is not one of them (vendor portal
  now uses `acknowledged`).

## Completion — 2026-08-11 (takeover agent)

All five waves landed:

- **Wave A** — two migrations: (1) `update_po_items_atomic` hardened (auth +
  business access + status guard), (2) `trg_po_commercial_fields_immutable` +
  occurrence-aware outbox keys + replenishment aligned to
  `inventory_expected_supply`; follow-up migration fixed the `received_quantity`
  runtime defect and packaging/UoM field loss. Edit page guards non-editable
  statuses.
- **Wave B** — `useProductDetailData` incoming figure reads the canonical view;
  replenishment reads the same view. One definition of "on order" remains.
- **Wave C** — branded supplier release email in `flushEmailOutbox`.
- **Wave D** — `po-status-single-writer.test.ts` (vitest) +
  `po_lifecycle_convergence_test.sql` (functional, rollback-wrapped).
- **Wave E** — ADR-0102 + procurement-verdict addendum (2).

Deviations from the wave text, all noted above: the edit-page guard is a
blocking explanation view rather than a toast redirect; Wave B reused the
existing product-detail hook rather than adding a new one (same view, less
surface); the `received_quantity` defect fix was unplanned but load-bearing —
the items writer was broken at runtime.
