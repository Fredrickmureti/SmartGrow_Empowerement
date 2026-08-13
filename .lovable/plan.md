# Landed Cost Domain — Live Status Plan

Authoritative status for the landed cost reconstruction. Update after every
completed unit of work.

## Currently active phase

Phase 5C — **COMPLETE**. Next active phase: **Phase 6.1 (Finance & Inventory
reporting surfaces)**.

---

## Fully implemented and verified

### Phase 5C.1 — Governance gate (DONE)
- `landed_cost.post` and `landed_cost.reverse` registered in
  `governance_action_registry` (`from_entity` subject mode).
- Posting logic extracted to private `_landed_cost_post_apply`;
  `landed_cost_post_voucher` now calls `approval_route` and parks the
  voucher in `pending_approval` when gated.
- `_mirror_approval_to_landed_cost` trigger on `approval_requests` applies
  the posting on approval and reverts to `allocated` on rejection.
- `guard_landed_cost_self_approval` blocks creator self-approval where
  policy forbids it.
- UI: `landedCostRpcs.ts` returns `gated` / `approval_request_id`;
  `useLandedCostActions.tsx` surfaces "Sent for approval" and a disabled
  "Awaiting approval" state.
- Verified: `npm run typecheck:landed-costs`.

### Phase 5C.2 — Charge type catalog (DONE)
- `LandedCostComponentTypesPage.tsx` manages code, name, allocation basis,
  capitalisation treatment and expense account mapping.
- Route `/purchases/landed-costs/component-types` registered; entry point
  added to the list page header.

### Phase 5C.3 — Document kind, snapshot and print pipeline (DONE)
- Migration registers the `purchases.landed_cost_voucher` document kind and
  its system template AST (`layout: landed_cost_voucher`), deliberately
  **without** an `email` intent — this is internal costing evidence, not
  counterparty correspondence.
- `src/services/documents/snapshots/purchasesLandedCostVoucher.ts` freezes
  header, charges (with accounting treatment), goods receipts in scope,
  per-line allocations, journal links and audit-trail actors.
- `supabase/functions/_shared/pdf/layouts/landedCost.ts` renders the
  dedicated ledger layout: shipment facts, charges table, receipts covered,
  per-line apportionment, and a **costing control** proving
  capitalised + expensed = total charges, plus an authorisation strip.
  Thermal paper is refused by construction.
- Registered in `LEDGER_LAYOUTS`; `assertLandedCostTemplateContract`
  forbids a `party` block or `line_items` preset ever creeping in.
- Registry + hooks wired: `resolveSourceDocumentRecord.ts`,
  `useRecordPrint.tsx`, `useRecordDownload.ts`, and Preview / Print /
  Download actions in `useLandedCostActions.tsx`.
- `docs/printing-event-coverage.md` matrix row added.
- Verified: `npm run typecheck:landed-costs`, architecture guard suite.

### Phase 6.2 (partial) — Architecture guards (DONE)
- `src/test/architecture/landed-cost.test.ts` (7 tests, passing) forbids
  browser writes to server-owned lifecycle columns, client-side currency
  conversion, hardcoded account/currency literals, and transitions that
  bypass the RPC wrapper.

---

## Pending work

### Phase 6.1 — Reporting surfaces (NEXT)
- Finance: landed cost charges must be traceable from the journal entry
  back to the voucher (drill-through on the posted entry).
- Inventory: product cost history / valuation report must attribute the
  uplift to its originating landed cost voucher.
- Purchases: per-shipment landed cost summary (charges vs allocated vs
  capitalised) available from the GRN and PO records.

### Phase 6.2 (remainder) — pgTAP coverage
- Allocation determinism and rounding-drift absorption.
- Refusal when no exchange rate is on file.
- Period-lock refusal on post.
- Governance gate: gated post parks in `pending_approval`; approval mirror
  applies; rejection reverts to `allocated`; self-approval blocked.
- Reversal produces a balanced counter-entry and restores unit cost.

### Phase 6.3 — Weight / volume allocation bases
- Blocked on product master carrying reliable weight and volume. Do not
  ship a basis that silently allocates zero.

---

## Instructions for the next agent

1. **Verify before you build.** Do not trust this document. Confirm each
   "DONE" item against the codebase and database:
   - `supabase--read_query` the `governance_action_registry` rows,
     `document_kinds` / template AST for `purchases.landed_cost_voucher`,
     and the trigger list on `landed_cost_vouchers` and
     `approval_requests`.
   - Read `landed_cost_post_voucher`, `_landed_cost_post_apply` and
     `_mirror_approval_to_landed_cost` end to end and satisfy yourself the
     gated path cannot post without approval.
   - Run `npm run typecheck:landed-costs` and
     `npx vitest run src/test/architecture/landed-cost.test.ts`.
   - Render a voucher PDF and confirm the costing control reconciles.
2. **Then resume at Phase 6.1**, not elsewhere. Finish reporting to a
   coherent, production-ready state before starting pgTAP work.
3. Keep execution chronological. No orphaned surfaces, no partial
   workflows, no jumping into unrelated domains.
4. Update this file immediately after each completed unit of work.
