# WMS Enterprise Build — Rolling Plan & Handoff Log

> **Read this file top-to-bottom before touching anything.** The handoff section is the source of truth for what to do next. Do NOT jump phases, do NOT invent new phases, do NOT redesign anything that's already SHIPPED. Stay in the chronological flow.

---

## ⇢ HANDOFF FOR NEXT AGENT (READ FIRST)

### Current state of the vision
The WMS foundation (Phases 0–13) is architecturally enterprise-grade — RPC-only state transitions, idempotent event outbox, per-phase architecture guards, Inventory-as-source-of-truth separation. The **surface area** is what remains to reach true Tier-1 parity (Manhattan / Blue Yonder / Körber class). We are working through the enterprise gaps in the order defined in "Roadmap to enterprise-grade" below. **Do not deviate from that order** unless the user explicitly redirects.

### What is SHIPPED and must NOT be re-opened
| Phase | Scope | Guard test | Status |
|---|---|---|---|
| 0–8   | Scaffold, LPNs, Receiving, Put-away, Picking, Packing, Cycle Count, QC, Replenishment | phase guards green | SHIPPED |
| 9     | Yard management | `wms-phase9.test.ts` | SHIPPED |
| 10    | Labour management | `wms-phase10.test.ts` | SHIPPED |
| 11    | 3PL activity billing | `wms-phase11.test.ts` | SHIPPED |
| 12    | Cross-dock + cartonization catalogue + `suggest_carton` / `assign_carton_to_pack` RPCs + GRN-completion crossdock trigger | `wms-phase12.test.ts` (6/6) | SHIPPED |
| 12.1  | PackStation wired to `suggest_carton` + `assign_carton_to_pack` + operator override dropdown | `wms-phase12.test.ts` | SHIPPED |
| 13    | RF / mobile operator shell at `/wm/*` (MobileHome, MobilePutaway, MobilePick, MobileCount, MobileReceive) + IndexedDB offline queue + queue-status chip + drain loop | `wms-phase13.test.ts` (6/6) | SHIPPED |

### What the NEXT AGENT must VERIFY before starting new work (fast checks, ~5 min)
1. Run `bunx vitest run src/test/architecture` — every `wms-phase*.test.ts` must be green. If red, STOP and fix before doing anything else.
2. Confirm `/wm` route loads in the preview and `MobileHome` renders the operator's tasks. Auth as an operator user with at least one open `wms_task` assigned.
3. Open browser DevTools → Application → IndexedDB → `wm-offline-queue`. Toggle offline, complete a mobile putaway, toggle online — the queued row must drain and disappear. This is the offline-queue smoke test.
4. Confirm `vite-plugin-pwa` is still wired in `vite.config.ts` (it already was pre-Phase 13; we did not touch it). No new SW code was added in Phase 13.
5. Check `docs/adr/` — ADRs 0079–0083 exist. **ADR 0084 was NOT written in Phase 13** (deferred as low value; the phase is a pure presentation layer over existing RPCs). Do not block on this.

### Known gaps left behind by Phase 13 (address in Phase 13.1, not later)
- No pack/dispatch/QC mobile screens yet. Operators still switch to desktop for these.
- `MobileReceive` calls `receive_goods_to_wms` at the whole-GRN level — there is no per-line scan-driven receive flow yet. If the user wants operator-side ASN line-scanning, that needs a new RPC variant (call it out to the user before building).
- The PWA manifest still has the AccrualFlow branding and `start_url: '/home'`. For a true "install the warehouse app to home screen" experience, we'd want a second manifest or a `/wm`-specific install prompt. Deferred until user asks.
- No integration test that exercises a full inbound→putaway→pick→pack→dispatch flow end-to-end through the real RPCs. Architecture guards prevent regressions but do not prove the happy path. Address in Phase 14.

### 🎯 START HERE NEXT — Phase 13.1: Complete the mobile shell
Do these in order, do not skip:
1. **`MobilePack`** at `/wm/pack/:packId` — reuse `PackStation.tsx` logic (open carton → scan carton label → scan pick lines into it → close carton → close pack). All RPCs go through `enqueue()`.
2. **`MobileDispatch`** at `/wm/dispatch/:shipmentId` — scan carton labels onto a shipment, confirm dispatch.
3. **`MobileQC`** at `/wm/qc/:taskId` — pass/hold/fail against `wms_qc_tasks`. Reuse the desktop QC RPCs.
4. Extend `src/test/architecture/wms-phase13.test.ts` to cover the three new routes (same enqueue-only + layout-uniformity assertions).
5. Update this handoff table with Phase 13.1 → SHIPPED when done.

Only after 13.1 is green, proceed to Phase 14 below.

---

## Roadmap to enterprise-grade (in order — do NOT reorder without user consent)

| # | Phase | Why it matters for enterprise parity |
|---|---|---|
| 13.1 | Mobile pack / dispatch / QC | Closes the mobile surface; operators never touch the desktop |
| 14   | End-to-end integration test harness (Vitest + real Supabase) covering inbound→dispatch | Tier-1 buyers require it; also unblocks safe refactors |
| 15   | Multi-carton bin-packing engine (replace single-carton `suggest_carton` with 3D pack solver) | Cartonization is currently naive; enterprise expects real bin-packing |
| 16   | Wave optimisation: batch / zone / cluster pick strategies + travel-path optimisation | Current wave planner is FIFO-only |
| 17   | Slotting execution: scheduled re-slot job that emits move tasks from velocity/affinity data | Slotting page is analysis-only today |
| 18   | Returns / reverse logistics + kitting + VAS | Whole missing domain |
| 19   | ASN EDI (X12 856 / EDIFACT DESADV) + carrier label & manifest integration | Table-stakes for enterprise inbound/outbound |
| 20   | Dock-door scheduling optimisation + cross-warehouse cross-dock | Extends Phase 9 + 12 |
| 21   | Real-time RF utilisation stream + SLA / exception workbench | Ops visibility layer |
| 22   | Labour: engineered standards, incentive calc, skill-based auto-assignment | Turns Phase 10 from descriptive to prescriptive |
| 23   | Billing: rate-card versioning + monthly close + auto-invoice into AR | Turns Phase 11 into revenue |

---

## Phase 13 — RF / Mobile Operator Shell (SHIPPED)

### What actually shipped (source of truth)
- Route tree: `src/apps/warehouse-mobile/routes.tsx` mounted at `/wm/*` in `src/App.tsx` behind `AppInstalledGate("warehouse")`.
- Layout: `src/apps/warehouse-mobile/MobileWarehouseLayout.tsx` — fixed top bar with back button + `QueueIndicator` chip; scrollable body; sticky bottom action bar; starts drain loop on mount.
- Pages (all in `src/pages/warehouse-mobile/`):
  - `MobileHome.tsx` — operator's tasks (filtered by `assignee_user_id = auth.uid()`), plus open goods receipts and open count sessions.
  - `MobilePutaway.tsx` — scan destination bin → `complete_putaway_task`.
  - `MobilePick.tsx` — scan source bin + product SKU + qty → `complete_pick_task`.
  - `MobileCount.tsx` — scan bin + SKU → `record_count`.
  - `MobileReceive.tsx` — pick staging bin → `receive_goods_to_wms`.
- Offline queue: `src/apps/warehouse-mobile/offlineQueue.ts` — IndexedDB via `idb`; single `enqueue()` chokepoint; network-error retry; UI-driven manual retry / discard via `QueueIndicator.tsx`.
- Guard: `src/test/architecture/wms-phase13.test.ts` — 6/6 green. Enforces:
  1. Mobile pages never call `supabase.rpc` directly (must go through `enqueue`).
  2. Every mobile page uses `MobileWarehouseLayout`.
  3. `offlineQueue` exports `enqueue`, `drainOnce`, `startDrainLoop`, `subscribe`.
  4. `/wm/*` mounted in App.tsx.
  5. All four scan flows routed.
  6. Layout starts drain loop + renders queue indicator.

### What was intentionally NOT done in Phase 13 (do not "helpfully" add these)
- No ADR 0084 (pure presentation layer over existing RPCs — no charter needed).
- No new tables, no new RPCs, no migration.
- No changes to `vite-plugin-pwa` config (already wired correctly).
- No pack / dispatch / QC mobile screens (that is Phase 13.1).
- No Capacitor packaging, no push notifications, no voice picking.

### RPC signatures relied upon (do not change without coordinating with mobile shell)
- `complete_putaway_task(p_task_id uuid)`
- `complete_pick_task(p_task_id uuid, p_picked_qty numeric, p_lpn_id uuid|null)`
- `record_count(p_line_id uuid, p_counted_qty numeric, p_note text|null)`
- `receive_goods_to_wms(p_goods_receipt_id uuid, p_staging_location_id uuid)`

---

## Operating rules for every future agent working on this WMS

1. **Never bypass the architecture guards.** If a new feature requires breaking a guard, first change the guard in the same commit with a written justification in the commit message and in this file.
2. **Never write to `wms_*` tables directly from the client.** All state transitions are RPC-only. This is the whole reason the architecture is defensible.
3. **Every new phase gets its own `wms-phaseN.test.ts` guard.** No exceptions. The guards are what let the next agent trust the previous agent's work.
4. **Every new mobile RPC call goes through `enqueue()`.** The phase-13 guard enforces this.
5. **Update this file at the end of every phase** — move the phase to SHIPPED in the handoff table, list what was actually built (not what was planned), list what was deferred, and set the "START HERE NEXT" pointer to the next phase in the roadmap.
6. **Do not reorder the roadmap** without the user explicitly asking. Each phase depends on the previous one being solid.
