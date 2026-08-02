# Receiving Subsystem — Implementation Status & Handoff (2026-08-02)

Authoritative status for the Receiving architecture audit roadmap
(`.lovable/plan/receiving-subsystem-architecture-audit-target-design-2026-08-02.md`).

## Current position

- Active phase: **none in progress** — Phases 1, 2, 3, 4a, 5a, 6, 7, 8 are complete and verified.
- Next milestone: **Phase 4b (retire the after-the-fact staging path)**, then **Phase 5b (session board lanes + activity timeline)**.

## Completed and verified

| Phase | Scope | Evidence |
| --- | --- | --- |
| 1 | Typed source-document binding (PO picker), expected-line materialisation on create, dock appointment / dock / supervisor binding | `src/pages/warehouse/ReceivingSessions.tsx`, `wms_materialize_expected_lines` |
| 2 | Line-grain capture on every scan/manual entry through `wms_capture_receiving_line` (base units, lot, serial, expiry, damage, hold, `client_scan_id` idempotency) | `src/features/warehouse/receiving/useReceivingLines.ts`, `ReceivingSessionWorkspace.tsx` |
| 3 | Derived shortage / overage / unexpected / damage / hold, raised as `wms_exceptions` | `wms_flag_receiving_variances`, `wms_receiving_session_progress` |
| 4a | One guarded posting path: goods receipt → inventory ledger → WMS staging → session `posted` | `wms_post_receiving_session` |
| 5a | Session workspace: expected vs received vs variance grid, capture panel, variance chips, progress in list, scanner presence chip | `ReceivingSessionWorkspace.tsx`, `src/features/warehouse/scanning/ScanStatusChip.tsx` |
| 6 | Mobile scan-first receiving loop (`/wm/receiving`, `/wm/receiving/:id`), offline/replay-guarded queue, home tile | `src/pages/warehouse-mobile/MobileReceiveSession.tsx`, `MobileHome.tsx`, `routes.tsx` |
| 7 | Canonical `wms.label.putaway` / `quality_hold` / `quarantine` templates seeded; ad-hoc `receiving_label` string removed | `src/features/warehouse/labels/wmsLabels.ts` |
| 8 | Architecture guards: no session flips from scans, capture/post only via sanctioned RPCs, mobile only via offline queue, labels via the WMS seam, presence + truck binding pinned | `src/__tests__/architecture.receiving-line-grain.test.ts` |

Verification run for this milestone: `tsgo --noEmit` clean;
`architecture.receiving-line-grain`, `wms-phase2`, `wms-label-keys-sync`,
`label-coverage` all green.

## Pending

- **Phase 4b — retire the after-the-fact staging path.** `ReceiveToWMSDialog`
  (used by `PutawayQueue.tsx`) still calls `receive_goods_to_wms` outside a
  receiving session. It must either be reframed as a session-bound action or
  removed once every entry point routes through `wms_post_receiving_session`.
  `src/test/architecture/wms-phase2.test.ts` asserts the dialog's current
  behaviour and will need updating with it.
- **Phase 5b — session board.** Lane-per-state board with carrier/trailer,
  dock, appointment window, supervisor and progress bar per card, plus a
  per-session activity/event timeline in the workspace. Today the list is an
  enriched table.
- **Phase 1 residual — trailer visits.** Sessions bind appointment + dock +
  supervisor; `wms_trailer_visits` is not yet linked, so seal/dwell context is
  still absent from the receiving surfaces.
- **Purchases GRN wizard convergence.** The wizard remains a second capture UI.
  Target state is that it renders the *document* produced by receiving.

## Instructions for the next agent

1. **Verify before extending.** Re-read `useReceivingLines.ts`,
   `ReceivingSessionWorkspace.tsx`, `MobileReceiveSession.tsx` and the
   receiving SQL functions, then run `tsgo --noEmit` plus the four test files
   listed above. Confirm: no surface writes `state` directly, every capture
   carries a `client_scan_id`, posting goes only through
   `wms_post_receiving_session`, and inventory remains the sole writer of
   quants/movements/cost layers.
2. **Then resume chronologically at Phase 4b**, not at an unrelated area.
   Bring the staging path to a single sanctioned entry point (including its
   guard test) before starting Phase 5b.
3. Keep each phase shippable: no orphaned UI, no partially wired workflow, and
   update this file immediately after each phase lands.

## Technical notes

- Receiving execution ledger: `wms_receiving_lines`; rollup view
  `wms_receiving_session_progress`.
- SQL seams: `wms_materialize_expected_lines`, `wms_capture_receiving_line`,
  `wms_flag_receiving_variances`, `wms_post_receiving_session`,
  `wms_transition_receiving` (FSM, `row_version` guarded).
- Scanner ownership is observable via `scanRouter.getActiveTargets()`, surfaced
  by `ScanStatusChip` on both desktop receiving surfaces.
