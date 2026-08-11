# Purchase Returns — Architecture Audit & Reconstruction Plan

## 1. What a purchase return is (first principles)

A purchase return is **not** one event. It is three independent realities that mature ERPs keep separate:

1. **Commercial intent** — "we are returning 5 of X received on GRN-17 because damaged." Needs authorization.
2. **Physical execution** — warehouse picks, inspects, packs, dispatches to the supplier; inventory leaves at dispatch, not at request.
3. **Financial settlement** — a vendor debit note / supplier credit reduces AP (or creates a receivable from the supplier), reconciled against the original bill.

Canonical lifecycle:

```text
PO -> GRN (line, lot/serial, warehouse, landed cost) -> Bill -> AP
                            |
                    problem discovered
                            v
   Return request (from GRN lines) -> governance approval -> warehouse task
   -> inspection -> dispatch -> INVENTORY LEAVES -> supplier acknowledgement
   -> vendor debit note -> AP adjustment -> reconciliation -> closed
```

Origin is the **goods receipt line** (plus lot/serial), never a free-typed product. Services and non-stock lines take the *financial adjustment only* path — no warehouse, no stock movement.

## 2. Current state — verdicts (evidence from code + live DB)

| Area | Verdict | Evidence |
|---|---|---|
| Source traceability | ❌ Missing | `purchase_returns` has only `vendor_id`, `bill_id`. No `purchase_order_id`, no `goods_receipt_id`; `purchase_return_items` has `bill_item_id` only — no `goods_receipt_item_id`, no lot/serial, no warehouse/location. The PO→GRN→lot chain cannot be reconstructed. |
| Returnable-quantity invariant | ❌ Missing | No `received − previously returned` check anywhere (no trigger, no RPC). Quantity is free-typed in `PurchaseReturnCreatePage`. Over-return and repeat-return of the same GRN line are both possible. |
| Numbering | ❌ Architecturally wrong | `get_next_purchase_return_number` uses `COALESCE(MAX(regexp_replace(...)))+1`, org-scoped, no advisory lock, no unique index on `(business_id, return_number)`. Concurrent creates collide/duplicate. Also *not* business-scoped, unlike the rest of the ERP. |
| Governance / SoD | ❌ Architecturally wrong | Zero rows in `approval_rules`/`self_action_policy` for returns, no `sod_purchase_returns_guard` trigger (only `update_purchase_returns_updated_at` exists). "Approve" is a raw client `UPDATE ... status='approved'` in `usePurchaseReturns.updatePurchaseReturn`. Same defect class already fixed in requisitions/RFQ/PO/bills. Creator self-approval is unrestricted. |
| Server authority | ❌ Architecturally wrong | Everything is client-driven: header insert, items insert, status flips, delete, edit-by-delete-and-reinsert. RLS grants `authenticated` full INSERT/UPDATE with only a `purchases:create/write` module permission — status and totals are client-authored. |
| Inventory boundary | ❌ Architecturally wrong | Stock is reduced **on approval**, in a browser `for` loop over items (`recordStockMovement`), and the failure is swallowed by `catch { console.error }` — a return can be "approved" with no stock movement. Warehouse is guessed from the active branch default. No idempotency key: a retried/double-clicked approval can reduce stock twice. |
| Warehouse execution | ❌ Missing (and duplicated) | A canonical warehouse returns engine already exists — `wms_return_orders` / `wms_return_lines` with `return_kind`, `vendor_id`, `state` FSM, `row_version`, warehouse/dock/carrier, disposition rules, photos, `credit_note_id`, RPC-only writes (guard: `wms-returns-guards.test.ts`). Purchase Returns ignores it entirely: a second, weaker return path. |
| Finance / AP | ⚠ Partially correct | Good: `create_vendor_credit_note_atomic(_issue: true)` is server-side, resolves accounts, posts via `post_journal_entry_atomic` (ADR 0132) — no client GL builder. Wrong: fired on a client status flip; collapses the whole return into **one synthetic line** ("Purchase return PR-…", qty 1, tax 0), so tax is never reversed, per-product/inventory-value detail is lost, and there is no partial/multi-document support or reversal path. |
| Tax & currency | ❌ Wrong | `tax_rate/tax_amount` columns exist on the items but the create form never sets them (`line_total = qty × price`), and the credit note is issued with `tax_rate: 0`. `currency` is free text; no FX rate captured, no exchange-difference handling. |
| Price basis | ⚠ Needs improvement | Unit price is typed by the user (scan path seeds `scanCostPrice`). Should derive from the GRN line's `unit_cost_basis` / landed cost, not from arbitrary input. |
| Reason | ⚠ Needs improvement | Free text on header + line (`reason`, `return_reason`, `condition`). `wms_return_disposition_rules` already provides structured reason/disposition vocabulary — unused here. |
| Barcode / scanning | ⚠ Needs improvement | Uses the shared scan session (correct engine), but resolves to a *product* only — not to a receipt line, lot, serial, or returnable balance. Enterprise return scanning must resolve inventory identity. |
| Multi-UoM | ✅ Correct | `packaging_id` / `display_quantity` / `display_uom_id` / `uom_snapshot` captured, base-unit normalization by trigger, pack provenance carried into the stock movement. Matches the multi-unit contract. |
| Lot / batch / serial | ❌ Missing | No lot or serial columns on the return line, though `goods_receipt_items` carries `lot_number`/`serial_number`. Returning destroys traceability. |
| State machine | ❌ Wrong | `pending → approved → processed → cancelled`. One status encodes authorization, physical movement and financial settlement simultaneously — "processed" is unknowable ("goods shipped?" vs "debit note posted?"). |
| Events / outbox | ❌ Missing | No `business_event_outbox` emission for returns (WMS returns and GRN/PO do emit). No downstream consumers, no retry, no idempotency. |
| Supplier lifecycle | ⚠ Needs improvement | Email exists but sends via `documentType: "credit_note" as never` — a cast lie. No RMA/authorization number, no acknowledgement, rejection, replacement, or dispute state. |
| Documents | ✅ Correct | `buildPurchasesReturnSnapshot` → `vendor_return` type through the canonical document engine, template seeded, print/download/preview via shared hooks. |
| RLS / grants | ⚠ Needs improvement | `purchase_return_items` policy is a legacy `FOR ALL` org-wide policy (no business/branch/permission check) — inconsistent with the v2 header policies. |
| Audit trail | ❌ Insufficient | `logAction` breadcrumbs only. Cannot answer: which GRN, which lot/serial, which warehouse, who approved under which governance mode, when goods physically left, which debit note, which GL entry, was the supplier notified/acknowledged. |
| Landing page | ⚠ Ambiguous | "Total Return Value" sums all statuses (requested, not financial); "Approved"/"Processed" ambiguous per the state-machine defect; search covers number/supplier only — not PO, GRN, bill, product, lot, serial. |

Live data: `purchase_returns` currently has **0 rows** — we can restructure without a data migration.

## 3. Target architecture

Purchase Returns becomes a thin **orchestrator** over engines that already exist:

```text
Return request (purchase_returns)  <- originates from GRN lines
   |-- governance: approval_requests + approval_rules + sod_purchase_returns_guard
   |-- physical:   wms_return_orders (return_kind='vendor')  -> stock movement at DISPATCH
   |-- financial:  create_vendor_credit_note_atomic (real lines + tax) -> AP
   |-- events:     business_event_outbox (Created/Submitted/Approved/Dispatched/Credited/Closed)
```

Ownership: inventory → Inventory engine; GL/AP → Finance; approval → governance engine; numbering → business-scoped sequence; paperwork → document engine; supplier email → document email engine. Purchase Returns owns only the commercial return document and its state machine.

## 4. Implementation phases

**Phase 1 — Schema & traceability.** Add to `purchase_returns`: `goods_receipt_id`, `purchase_order_id`, `warehouse_id`, `reason_code`, `return_kind` (goods/financial), `rma_reference`, `exchange_rate`, `wms_return_order_id`, `vendor_credit_note_id`, `submitted_at/approved_at/dispatched_at/closed_at` + actors, `row_version`. Add to items: `goods_receipt_item_id`, `lot_number`, `serial_number`, `location_id`, `unit_cost_basis`. Unique index on `(business_id, return_number)`; unique partial index preventing duplicate credit notes per return. Replace the item RLS policy with business/branch/permission-scoped v2 policies.

**Phase 2 — Numbering.** Replace `get_next_purchase_return_number` with the ERP's business-scoped, lock-based sequence writer; number assigned server-side at creation, never in the browser.

**Phase 3 — Server-authoritative commands.** RPCs: `purchase_return_create` (validates GRN lineage, derives price/UoM/lot from the GRN line, enforces `returnable = received − returned`, assigns the number), `purchase_return_submit`, `purchase_return_approve`, `purchase_return_reject`, `purchase_return_cancel`, `purchase_return_dispatch`, `purchase_return_acknowledge`, `purchase_return_close`. All take `row_version` and an idempotency key. Revoke client `INSERT`/`UPDATE` on status/number/totals/settlement columns; add an architecture ratchet test mirroring `expense-domain-ownership.test.ts`.

**Phase 4 — Governance.** Register `purchase_return.approve` (and submit/dispatch) in the self-action catalogue, seed `self_action_policy`, add `sod_purchase_returns_guard`, route approvals through `approval_requests`. Delete the client-side approve/process flips.

**Phase 5 — Inventory & warehouse.** Stock leaves **only** at dispatch, inside the dispatch RPC, keyed for idempotency, never in a browser loop and never swallowing errors. Goods-type returns spawn a `wms_return_orders` (`return_kind='vendor'`) task; the WMS engine owns pick/inspect/pack/dispatch and calls back into the return's dispatch transition. Financial-only returns skip this entirely.

**Phase 6 — Finance.** Issue the vendor debit note from **real return lines** with per-line tax and cost basis, at the correct trigger point (dispatch or acknowledgement, per policy), supporting partial returns and multiple credit documents; add a reversal path and surface debit notes in AP ageing/reconciliation against the source bill.

**Phase 7 — Events & audit.** Emit outbox events per transition; write structured audit rows carrying GRN/lot/serial/warehouse/governance-mode/GL-entry references so the auditor questions are answerable from data.

**Phase 8 — UX realignment.** Creation starts from *Select supplier → receipt/bill → returnable lines* with server-computed returnable balances; scanning resolves to a receipt line/lot, not just a product; structured reason codes; separate request vs dispatch vs accounting dates; explicit lifecycle pipeline; landing metrics relabelled to unambiguous meanings (Requested value / Awaiting approval / Awaiting dispatch / Credited); search extended to PO, GRN, bill, product, lot, serial.

## 5. Notes

Phases 1–2 and 3–7 each involve database migrations, which need your approval as they are created. No new engines are introduced — every capability is delegated to the existing inventory, WMS returns, governance, finance, document, email, outbox and numbering infrastructure.
