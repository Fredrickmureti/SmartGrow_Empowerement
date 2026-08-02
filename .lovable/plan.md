# License Plate (LPN) Rebuild — Live Status

Authoritative roadmap: `.lovable/plan/license-plate-lpn-architecture-audit-findings-rebuild-plan-2026-08-02.md`
Architecture decision: `docs/adr/0102-license-plate-handling-units.md`

## Completed and verified

**Phase 0 — unblock build.** Tailwind v3.4.17 pinned (v4 plugin mismatch), `JSX` namespace
error in `useScanFeedback.tsx` fixed. Dev server boots; typecheck clean.

**Phase 1 — inventory-bearing plates.** `stock_quants.lpn_id` added; quant identity index is
now `(product_id, location_id, lot_number, package_id, owner_id, lpn_id)`. `wms_lpn_events`
audit ledger created (grants → RLS → policies). `wms_next_lpn_code` mints server-side
`PLT-YYMM-NNNNN` codes. `wms_lpn_tree` recursive helper for nesting.
Deviation from the original plan, deliberate: **no `wms_lpn_contents` table** — contents are
the quant rows carrying `lpn_id`, keeping one ledger instead of two. Recorded in ADR 0102.

**Phase 2 — operations as RPCs.** `wms_lpn_move` (cascades to child plates and every quant),
`wms_lpn_load`, `wms_lpn_unload`, `wms_lpn_split`, `wms_lpn_merge`, `wms_lpn_nest`,
`wms_lpn_unnest`, all `SECURITY DEFINER` and business-guarded, all writing `stock_movements`
and `wms_lpn_events`. `v_wms_lpn_overview` aggregates sku_count / total_quantity /
child_count. `_maintain_stock_quants` fixed to conflict on the six-column identity and to
skip `reference_type = 'wms_lpn'` movements (the RPCs own those balances).

**Phase 3 — workspace UI.** `LicensePlates.tsx` rebuilt as an operational board (KPI strip,
filters, multi-select, bulk actions). `LicensePlateView.tsx` rebuilt as a handling-unit
cockpit (contents, nesting tree, handling ledger, FSM-gated action rail).
`src/features/warehouse/lpn/useLpnOps.ts` is the single mutation entry point.

**Phase 4 — scanning.** Both surfaces subscribe to the existing registry via
`useWmsScanIntent` (`putaway.lpn`, `putaway.bin`). No second scanning stack.

**Phase 5 — printing.** `lpnLabels.ts` (variable binding, `previewLpnLabel` compile via
`renderLabelPayload`, `printLpnLabel` with reprint reason) and `LpnLabelDialog.tsx`
(Generate → Preview → Validate → Print, copies, reprint reason codes, bulk runs from the
board selection). Every print writes `label_printed` / `label_reprinted` to the plate ledger.

**Phase 6 — deletions.** `move_lpn` dropped; `complete_putaway_task` repointed to
`wms_lpn_move`. The `package_id`-as-plate contents query and the browser code generator are
gone. No compatibility shims.

**Phase 7 — guards.** ADR 0102 written. `src/test/architecture/lpn-handling-units.test.ts`
(7 tests) and the updated `wms-phase1.test.ts` pass.

## Currently active

Phase 7 closed. The module is at a coherent, production-ready state for the desk workflows.

## Pending — next milestones, in order

1. **Mobile plate workflow.** A `warehouse-mobile` plate screen: scan → contents → move /
   load / unload, thumb-reachable, offline-tolerant queueing consistent with the other
   mobile WMS screens. This is the one roadmap item from Phase 3/4 not yet delivered.
2. **Lifecycle completion.** `wms_lpn_seal`, `wms_lpn_dispatch`, `wms_lpn_receive_return`,
   `wms_lpn_retire` as explicit RPCs, wired to the FSM-gated action rail. Today those
   statuses are reachable only through the generic `wms_transition_lpn`.
3. **Scale.** Virtualised grid (TanStack Virtual) and saved views on the board once plate
   counts justify it.
4. **Plate metadata.** `container_type_id`, tare/gross weight, `is_returnable` — deferred
   from Phase 1 because nothing consumes them yet; add with the returnable-container feature.

## Handoff to the next agent

Before writing code, verify the above rather than trusting it:

- `bunx vitest run src/test/architecture/lpn-handling-units.test.ts` and
  `bunx tsgo --noEmit -p tsconfig.app.json` must both be clean.
- Exercise the invariant that matters most: load stock onto a plate, move the plate to
  another bin, and confirm `stock_quants` rows followed the plate (`location_id` updated,
  quantities unchanged, no duplicate quant rows) and that `stock_movements` +
  `wms_lpn_events` both recorded it. Then split and merge and re-check totals.
- Confirm no double-counting: `_maintain_stock_quants` must still skip
  `reference_type = 'wms_lpn'`.
- Read `docs/adr/0102-license-plate-handling-units.md` first; it is the contract.

Then resume at pending item 1 (mobile plate workflow) — do not start unrelated work, and
finish each item to a production-ready state before moving on.
