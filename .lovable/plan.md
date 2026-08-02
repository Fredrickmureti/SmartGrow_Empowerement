
# License Plate (LPN) — Verification Result & Continuation Plan

## Phase 1 — Independent verification (done, evidence-based)

Checked the live database (`pg_proc`, `information_schema`, view/function definitions) and the source tree against every claim in `.lovable/plan.md`.

**Confirmed genuinely complete**

- `stock_quants.lpn_id` exists; `_maintain_stock_quants` conflicts on the six-column identity **and** skips `reference_type = 'wms_lpn'` (verified in the deployed function body) — no double counting.
- `wms_lpn_events` table with the full audit shape (from/to location, from/to status, counterpart plate, quantity delta) exists.
- Operation RPCs exist and are `SECURITY DEFINER`: `wms_lpn_move`, `load`, `unload`, `split`, `merge`, `nest`, `unnest`, plus `wms_next_lpn_code` and `wms_lpn_tree`.
- `move_lpn` is genuinely dropped (absent from `pg_proc`); `complete_putaway_task` now calls `wms_lpn_move`.
- `v_wms_lpn_overview` exists; `useLpnOps.ts` is the single mutation entry point; both pages subscribe to `useWmsScanIntent`; label preview/print/reprint go through `renderLabelPayload` → `printWmsLabel` and write `label_printed` / `label_reprinted`; ADR 0102 exists.

**Claims that do NOT hold**

1. **"FSM-gated action rail" is false.** The detail page gates buttons on two ad-hoc booleans (`locked`, `sealed`), not on the FSM. The database FSM (`wms_transition_lpn`) allows `packed>sealed` only, yet the UI offers **Seal** from any state — the RPC will reject it at runtime with `wms_lpn_bad_edge`. Same class of bug for other rail actions.
2. **"Retire" still writes `voided`** — the exact mislabel the original audit called out. `retired` is reachable only from `shipped` in the FSM, and the button never can reach it.
3. **Lifecycle events are still missing.** `wms_lpn_seal`, `wms_lpn_dispatch`, `wms_lpn_receive_return`, `wms_lpn_retire` do not exist; returns have no edge in the FSM at all (there is no path back from `shipped` into stock).
4. **"Tests pass" is unverified and currently unverifiable** — `vitest` is not installed in `node_modules` (`@vitejs/plugin-react-swc` also unresolved), so the suite cannot run in this environment as it stands.
5. Mobile plate workflow absent (correctly listed as pending), full location hierarchy path (Warehouse → Zone → Aisle → Rack → Bin) not rendered anywhere — only a bare bin code, and grid is unvirtualised with a hard `limit(500)`.

Net: the **domain layer is real and sound**; the **lifecycle tail and the UI's contract with the FSM are not**. Resume at item 0 below, not at the claimed "pending item 1".

## Phase 2 — Revised plan

### 0. Restore the verification harness (blocking)
Install the missing dev toolchain (`vitest`, correct React vite plugin) and run `src/test/architecture/lpn-handling-units.test.ts`, `wms-phase1.test.ts` and `tsgo --noEmit`. Nothing else ships until these are green, since every later phase is guarded by them.

### 1. Make the FSM authoritative and visible (fixes the false claim)
- Replace the hardcoded `CASE` inside `wms_transition_lpn` with a real edge table `wms_lpn_status_edges` (from_status, to_status, requires_reason, verb label), seeded with the full lifecycle graph including the return path (`shipped>returned>quarantined|stored`) and a correct `>retired` terminal from `shipped`, `stored` and `returned`.
- Expose it read-only to `authenticated` so the action rail is **derived**, not guessed: a button exists only when the edge exists for the plate's current status.
- Rewrite the detail page's action rail against that data. Delete the `locked`/`sealed` boolean gating.

### 2. Lifecycle completion as first-class RPCs
`wms_lpn_seal`, `wms_lpn_dispatch`, `wms_lpn_receive_return`, `wms_lpn_retire` — `SECURITY DEFINER`, business-guarded, `row_version`-checked, each writing `stock_movements` where stock actually leaves/enters (dispatch consumes plate quants out of the bin; return re-instates them) and a `wms_lpn_events` row. Retirement releases the plate code for returnable containers and blocks retirement while contents remain.

### 3. Mobile plate workflow
A `warehouse-mobile` plate screen matching the existing mobile set: scan a plate → identity + contents → move / load / unload, thumb-reachable, using the existing scan-intent registry and `offlineQueue` so a dropped connection queues rather than fails.

### 4. Warehouse context and scale
- Render the full hierarchy path on both surfaces via the existing location resolver, not a bare bin code.
- Virtualise the board grid (TanStack Virtual) and replace the hard 500-row cap with keyset paging; add faceted filters and saved views.

### 5. Guards
Extend `lpn-handling-units.test.ts`: no UI-side status conditional (the edge table is the only source of allowed transitions), no `voided`-as-retire, every lifecycle RPC has a call site, mobile plate screen subscribes to a scan intent. Update ADR 0102 with the edge-table decision and refresh `.lovable/plan.md` with the corrected status above.

## Technical notes

Migrations follow grant → RLS → policy order. All new RPCs re-check `user_can_access_business`. Dispatch/return movements carry `reference_type = 'wms_lpn'` so `_maintain_stock_quants` keeps skipping them and the RPC stays the sole balance author. No compatibility shims; superseded UI branches are deleted, not wrapped.
