# Delivery Note Domain — Audit Findings and Convergence Plan

## What a Delivery Note means here (verified from schema + RPCs)

The DN is the **goods-issue document**: the only event on the sales side that moves physical stock. Revenue/AR post at invoice confirmation; inventory and COGS post at DN completion. That separation matches mature ERP practice (SAP delivery vs billing, Odoo stock.picking vs account.move, NetSuite item fulfilment vs invoice) and is **correct as designed** — it is preserved.

Verified origins, all with server-side atomic RPCs except one:
- Sales Order -> `create_delivery_from_sales_order_atomic`
- Invoice (auto, at confirmation) -> `confirm_invoice_atomic` creates a pending DN
- Return -> `create_return_delivery_atomic`
- Manual -> **client-side inserts** (the outlier; defect 4)

Canonical lifecycle RPCs exist: `mark_delivery_ready_atomic`, `dispatch_delivery_atomic`, `update_delivery_logistics_atomic`, `complete_delivery_atomic` (stock + lot/FEFO + cost snapshot + COGS GL + optional spawned invoice), `record_partial_delivery_atomic` (+ backorder), `cancel_delivery_atomic` (compensating movements + JE void), `create_invoice_from_delivery_atomic`, plus WMS manifest bridging.

## Confirmed defects (each with evidence)

**1. Contact relationship ambiguity — the reported error.**
`delivery_notes` has two FKs into `contacts`: `contact_id` (the customer, guarded by `enforce_delivery_note_contact_business_match`) and `received_by_contact_id` (who physically signed for the goods). Both are legitimate and model distinct business roles. The list hook, paginated hook and the PDF snapshot builder already disambiguate (`contacts!contact_id`, `contacts!delivery_notes_contact_id_fkey`). Only the record surfaces do not: `useDeliveryNoteRecord.ts` and `DeliveryNoteRecordPage.tsx` use a bare `contacts(...)` embed. Classification: **correctness defect, local to two files** — the schema is right, the query is wrong. No other consumer relies on implicit resolution, so disambiguating cannot break another page.

**2. Two readers for one record.** `DeliveryNoteRecordPage` runs its own `.from("delivery_notes").select(...)` instead of using `useDeliveryNoteRecord`. Classification: architectural drift; it is why the same bug exists twice.

**3. Client-owned lifecycle writes.** `useDeliveryNotes.updateDeliveryNote` passes an arbitrary column bag to `.update()`, including `status`, and there is **no status write-guard trigger** on `delivery_notes` (estimates and sales orders have one). A raw update to `delivered` fires `delivery_notes_emit_completed` and `sms_delivery_shipped_trg` — the customer gets a shipped SMS and the event stream records a completed goods-issue — while **no stock movement, no cost snapshot and no COGS journal exist**. Classification: **data-integrity + lifecycle defect, highest severity**.

**4. Non-atomic manual creation.** `createDeliveryNote` does: RPC for a number, then insert header, then insert items, from the browser, with no transaction. Classification: transactional-ownership defect.

**5. Numbering is unsafe.** `get_next_delivery_number` is a `MAX(...)+1` scan with **no advisory lock**, and there is **no unique index on `delivery_number`** (verified against `pg_indexes`). Concurrent creation yields duplicate numbers that both persist. It is also org-scoped while the rest of the table is business+branch scoped. Classification: concurrency + data-integrity defect.

**6. Client-side hard delete of a business document.** `deleteDeliveryNote` deletes the row, gated only by a client-side status check; the RLS delete policy allows any sales-manage user to delete any DN regardless of status, lineage or spawned invoice. Classification: data-integrity defect.

**7. Quantity ledger is thin (accepted design, reporting gap).** `delivery_note_items` carries only `quantity_ordered` and `quantity_delivered`. SO-side truth lives in the `so_line_balances` view, and returns are modelled as separate `is_return` DNs rather than by rewriting history — so history is **not** destroyed. What is missing is a derived DN-level invoiced/returned balance view. Not a correctness defect.

## What is explicitly NOT being changed

Invoice->DN auto creation, DN->invoice spawning, the two-mode release policy (ADR 0026 s6), COGS-only-at-goods-issue, return-as-separate-DN, per-product over-delivery caps, lot/FEFO consumption, WMS manifest bridging, and every existing atomic RPC. The evidence supports them; they stay.

## Convergence plan

**Phase 1 — unblock the record surface (no schema change).**
Disambiguate both record reads to `contacts!delivery_notes_contact_id_fkey`, and also embed `received_by_contact:contacts!received_by_contact_id(name)` so the record page resolves the recipient through the same four-tier chain the PDF uses. Remove the duplicate fetch in `DeliveryNoteRecordPage` and route it through `useDeliveryNoteRecord`.

**Phase 2 — close the lifecycle bypass (migration).**
- Trigger `_dn_status_write_guard`: reject any `status` change not made by the DN RPCs (the session-token pattern already used elsewhere in this codebase), so `pending -> delivered` can only happen through `complete_delivery_atomic`.
- Narrow `updateDeliveryNote` to an explicit whitelist of logistics/metadata columns; status transitions go through the existing RPCs.
- Replace the hard delete with `cancel_delivery_atomic` in the UI, and tighten the RLS delete policy to pending/draft rows with no spawned invoice and no movements.

**Phase 3 — atomic creation and safe numbering (migration).**
- `create_delivery_note_atomic(p_payload jsonb, p_lines jsonb)` — allocates the number under an advisory lock and inserts header + lines in one transaction, enforcing business/branch coherence. `createDeliveryNote` calls it.
- Rewrite `get_next_delivery_number` to be business-scoped and take `pg_advisory_xact_lock`; add a unique index on `(organization_id, business_id, delivery_number)` after a duplicate check.

**Phase 4 — quantity visibility.**
Add a `dn_line_balances` view deriving delivered / invoiced / returned per DN line from delivery notes, spawned invoices and return DNs, so no app code re-sums lines (mirrors the `so_line_balances` rule).

**Phase 5 — ratchets and verification.**
- ESLint rule `no-ambiguous-contacts-embed` for any bare `contacts(` embed on a multi-FK table.
- Architecture test asserting no client-side write to `delivery_notes.status` and no client `.insert`/`.delete` on `delivery_notes`.
- pgTAP additions to `supabase/tests/delivery_notes_invariants_test.sql`: the status guard rejects direct updates; concurrent numbering yields distinct numbers; completion still produces movement + cost snapshot + COGS in one transaction.
- ADR 0011/0026 updated with the guard, the numbering contract, and the two contact roles.

Phases 2-4 require migrations, surfaced individually for approval.