# WMS Handoff — Verification + Resume Plan

## Verification of prior work (Phase 14a–14e)

Independently checked against live `pg_proc`, migrations, and spec files:

- **14a scaffolding** — Playwright projects `wms`+`wm`, `e2e/support/{auth,seed}.ts`, all 6 desktop specs + `e2e/wm/offline-drain.spec.ts`, and `src/test/architecture/wms-phase14.test.ts` are present. ✅
- **14a.1 wrapper RPCs** — `assign_wms_task`, `claim_pick_task`, `cancel_pick_wave`, `record_goods_receipt_line`, `record_count_scan`, `approve_count_variance` all exist in `pg_proc`. ✅
- **14b–14e specs** — `receive.spec.ts`, `putaway.spec.ts`, `wave.spec.ts`, `pick-pack-dispatch.spec.ts` are all unskipped and exercise real read-back state; every RPC they name (pick/pack/manifest/receipt suite) is present in the DB. ✅
- **QC + count RPC surface** — `open_qc_inspection`, `accept_qc_inspection`, `reject_qc_inspection`, `cancel_qc_inspection`, `create_count_session`, `record_count_scan`, `approve_count_variance`, `post_count_session` all exist. No new wrappers required for 14f/14g. ✅
- **Seed function** — `wms_e2e_ensure_seed()` exists. ✅

Gaps found (added to backlog, not blockers for 14f):

1. **`create_goods_receipt` wrapper never landed** — `wms-phase14.test.ts` SPECS still names it and `receive.spec.ts` header carries a `TODO(14a.2)`. Currently the receive spec inserts the GRN header directly. Track as **14a.2** and fold into 14f's migration batch since it's a small SECURITY DEFINER wrapper.
2. **`wms_qc_hold_reasons` is empty across all businesses** (0 rows). 14f seed extension must insert at least one reason for the caller's business — idempotent, business-scoped, per standing rules.
3. **Guard spec name mismatch for count** — `count.spec.ts` header references `open_count_session` / `close_count_session` but the real RPCs are `create_count_session` / `post_count_session`. Fix header + guard `SPECS` entry as part of 14g.

## Resume order

### 14f — QC spec (next)
1. Extend `wms_e2e_ensure_seed()`: insert one `wms_qc_hold_reasons` row for the caller's business if none exists (idempotent).
2. Add thin `create_goods_receipt(p_po_id, p_warehouse_id)` wrapper RPC (`SECURITY DEFINER`, business-scoped, outbox emit). Update `receive.spec.ts` to use it and drop the direct-insert block; remove the `TODO(14a.2)`.
3. Unskip `e2e/wms/qc.spec.ts`. Reuse the receive→putaway fixture pattern from `pick-pack-dispatch.spec.ts` to land three lots at `E2E_STOCK`, then:
   - `open_qc_inspection` on each.
   - `accept_qc_inspection` on lot A — assert quant released to available (source bin unchanged, no hold movement).
   - `reject_qc_inspection` on lot B — assert quant moved to hold bin and a `stock_movements` row with a quarantine type exists.
   - `cancel_qc_inspection` on lot C — assert inspection state cancelled, quant untouched, second cancel is `noop`.
   - Assert `warehouse.qc.accepted` / `warehouse.qc.rejected` / `warehouse.qc.cancelled` outbox rows landed once each.

### 14g — Count spec
1. Fix spec header + `wms-phase14.test.ts` SPECS entry to `create_count_session` / `post_count_session`.
2. Unskip `e2e/wms/count.spec.ts`. Fixture: top up stock at `E2E_STOCK` via receive→putaway.
   - `create_count_session` scoped to `E2E_STOCK`.
   - `record_count_scan` for a matched line + a variance line.
   - `approve_count_variance` on the variance line.
   - `post_count_session`.
   - Assert `stock_quants` matches counted qty, a variance `stock_movements` row of type `adjustment` exists, and `stock.movement.adjusted` (or the actual event name emitted by `approve_count_variance`) is present in outbox once.

### 14h — Mobile offline drain
Unskip `e2e/wm/offline-drain.spec.ts`.
1. Restore session, navigate `/wm/pick`.
2. `context.route('**/rest/v1/rpc/complete_pick_task', route => route.abort())` — trigger completion via UI or `enqueue()` helper.
3. Assert IndexedDB `wm-offline-queue` contains the queued call and the layout shows the queue indicator.
4. Unroute, wait for the drain worker tick, assert queue empty **and** the target `wms_tasks.state = 'done'` server-side.

### 14i — Guard hardening
Extend `src/test/architecture/wms-phase14.test.ts`:
1. Fail if any `describe.skip(` remains in `e2e/`.
2. Load `supabase/tests/wms/rpc-snapshot.json` (checked in, regenerated from `pg_proc`) and fail if any name in `SPECS` is missing from it — catches DB drift.
3. Generate the snapshot via a small `scripts/wms/dump-rpc-snapshot.ts` (documented, run manually after RPC migrations).

## Standing rules (unchanged)
- All new RPCs: `SECURITY DEFINER`, `SET search_path = public`, business-access gated, outbox emit with idempotency key `wms.<entity>:<id>:<state>`.
- Seed extensions stay idempotent and scoped to caller's active business.
- No phase is "done" until spec is unskipped and asserts real read-back state (table + outbox).

## Post-14 roadmap (unchanged)
15 Warehouse Master polish · 16 Layout designer · 17 Ops dashboard · 18 Task engine · 19 Location intelligence · 20 Cross-dock + returns · 21 RLS re-audit · 22 ERP integration surface.
