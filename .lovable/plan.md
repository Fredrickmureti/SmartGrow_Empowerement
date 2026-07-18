
## Verification of prior work

Confirmed against `.lovable/plan.md` handoff:

- Phases 0–13 marked SHIPPED. Spot-checks:
  - `src/apps/warehouse-mobile/{routes,MobileWarehouseLayout,QueueIndicator,offlineQueue}.tsx/ts` all exist.
  - `src/pages/warehouse-mobile/` contains MobileHome, MobilePutaway, MobilePick, MobileCount, MobileReceive.
  - `/wm/*` mounted in `src/App.tsx` behind `AppInstalledGate("warehouse")`.
  - `wms-phase1..13.test.ts` guards present; `wms-phase13.test.ts` runs green (6/6).
  - Desktop counterparts for the remaining flows exist: `PackStation.tsx`, `LoadingManifests.tsx` / `LoadingBay.tsx` (dispatch), `QCQueue.tsx` / `QCInspectionDetail.tsx`.
  - ADRs 0079–0083 present; 0084 intentionally deferred (documented).

No evidence of skipped, faked, or partial Phase 13 work. Deferred items (pack/dispatch/QC mobile screens, full E2E harness) are correctly parked and match the handoff notes. Roadmap ordering is coherent; nothing to re-open.

## Next milestone — Phase 13.1: Complete the mobile shell

Per the "START HERE NEXT" pointer. Presentation layer only — no new tables, no new RPCs, no migrations. Every RPC call must route through `offlineQueue.enqueue()` to satisfy the Phase 13 guard.

### Deliverables

1. **`MobilePack`** at `/wm/pack/:packId`
   - Reuse logic from `src/pages/warehouse/PackStation.tsx`: open carton → scan carton label → scan pick lines into it → close carton → close pack.
   - RPCs (already exist, invoked via `enqueue`): `suggest_carton`, `assign_carton_to_pack`, plus the pack open/close RPCs PackStation already uses. No signature changes.
   - Operator override dropdown for carton type, mirroring desktop.

2. **`MobileDispatch`** at `/wm/dispatch/:shipmentId`
   - Scan carton labels onto a shipment, confirm dispatch.
   - Reuse the existing loading-manifest / dispatch RPCs consumed by `LoadingManifests.tsx` / `LoadingBay.tsx`.

3. **`MobileQC`** at `/wm/qc/:taskId`
   - Pass / hold / fail against `wms_qc_tasks`; reuse RPCs called by `QCInspectionDetail.tsx`.

4. **Router wiring** in `src/apps/warehouse-mobile/routes.tsx` for the three new routes.

5. **Guard extension** `src/test/architecture/wms-phase13.test.ts` (or a sibling `wms-phase13-1.test.ts` to keep phase provenance):
   - Enforce enqueue-only RPC usage on the three new pages.
   - Enforce `MobileWarehouseLayout` usage.
   - Assert the three new routes are mounted at `/wm/pack/:packId`, `/wm/dispatch/:shipmentId`, `/wm/qc/:taskId`.

6. **Handoff update** in `.lovable/plan.md`: move Phase 13.1 to SHIPPED with the actual list of RPCs relied upon, and repoint "START HERE NEXT" to Phase 14 (end-to-end integration harness).

### Guardrails carried forward

- No direct `supabase.rpc` calls in mobile pages — always via `enqueue()`.
- No client writes to `wms_*` tables; RPC-only state transitions.
- No changes to shipped desktop pages, RPCs, or `vite-plugin-pwa` config.
- Keep MobileWarehouseLayout as the sole shell.

### Verification before declaring done

- `bunx vitest run src/test/architecture` — all `wms-phase*.test.ts` green (including the extended Phase 13 guard).
- Manual smoke via preview `/wm/pack/:id`, `/wm/dispatch/:id`, `/wm/qc/:id` render the layout + queue chip; offline toggle → action → online drains the queue row.

### Explicitly out of scope for 13.1

- ASN per-line scan-driven receive (would require a new RPC variant; defer until user asks).
- PWA manifest split for `/wm`.
- Any Phase 14+ work.

On approval, I will implement 13.1 end-to-end (pages, router entries, guard extension, handoff log update) and run the architecture suite before returning.
