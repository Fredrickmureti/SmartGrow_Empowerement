# Purchase Returns — reconstruction status

## Currently active
Phase 8 (UI realignment) — **implemented this turn, awaiting verification by the next agent.**

## Fully implemented and verified
- **Phase 1–2 (schema, traceability, numbering)** — lineage columns on `purchase_returns`
  (`goods_receipt_id`, `purchase_order_id`, `warehouse_id`, `wms_return_order_id`,
  `vendor_credit_note_id`, `approval_request_id`), line-level provenance
  (`goods_receipt_item_id`, `lot_number`, `serial_number`, `location_id`, `unit_cost_basis`),
  `purchase_return_events` audit table, business-scoped unique numbering under advisory lock,
  scoped RLS on `purchase_return_items`.
- **Phase 3–7 (server authority)** — client `INSERT/UPDATE/DELETE` revoked on both tables;
  `_purchase_return_guard` blocks non-command writes; lifecycle commands
  `purchase_return_create / update_draft / submit / approve / reject / cancel / dispatch /
  acknowledge / raise_credit / close`; governance via `approval_route` +
  `_mirror_approval_to_purchase_return`; stock leaves only at dispatch; WMS return order on
  approve; vendor debit note via `create_vendor_credit_note_atomic`; outbox events.
- **Phase 8 (UI realignment, this turn)**
  - `src/lib/purchases/purchaseReturnRpcs.ts` — the only client mutation surface; reason-code
    catalogue; returnable-lines reader.
  - `src/hooks/usePurchaseReturns.ts` — read-only; all client mutations removed.
  - `src/features/purchases/returns/useReturnableReceipts.ts` — receipt pick list +
    remaining-returnable ledger per receipt line.
  - `PurchaseReturnCreatePage.tsx` — goods returns picked from a goods receipt with
    returnable-quantity clamping, lot/serial visible, condition + line note per line;
    separate explicit `financial` adjustment path.
  - `PurchaseReturnEditPage.tsx` — draft-only amendment via `purchase_return_update_draft`
    with `row_version`; provenance immutable.
  - `usePurchaseReturnActions.tsx` — full lifecycle vocabulary on the RPCs, with prompts for
    reject / cancel / dispatch / acknowledge.
  - `PurchaseReturns.tsx` — read-only list, 7-step pipeline, debit-note column, KPIs by
    lifecycle stage; row menu adopts the shared action vocabulary.
  - `purchaseReturnView.tsx` + `usePurchaseReturnEvents.ts` — source-document links,
    settlement state, append-only lifecycle trail.
  - `PurchaseReturnPeekSheet.tsx` — primary lifecycle step + draft-only Edit.
  - Typecheck clean.

## Pending
- **Phase 9 — ratchets and tests.** Architecture test asserting no client file writes
  `purchase_returns` / `purchase_return_items` directly and no client-side stock movement or
  debit-note insert for returns; pgTAP coverage for over-return rejection, dispatch stock
  effect, `raise_credit` idempotency and SoD on approve.
- **Phase 10 — notifications and documents.** Supplier-facing return/RMA document template and
  the notification bindings on dispatch / credit.
- Legacy rows still carrying `pending` / `processed` need a data-migration decision
  (map to `draft` / `closed`) — currently only tolerated in the UI.

## Next agent
1. Verify Phase 8 first: confirm no client writes remain (`rg "from\(\"purchase_returns\"" src`
   should show SELECT only), walk create → submit → approve → dispatch → raise credit → close
   in the preview against a real goods receipt, and confirm over-return is rejected server-side.
2. Then resume at **Phase 9** (ratchets + pgTAP). Do not start unrelated modules.
