## Phase 13.1 — SHIPPED (2026-07-18)

Mobile shell completed. Presentation layer only — zero migrations, zero
new RPCs, zero desktop changes.

### Delivered

1. `src/pages/warehouse-mobile/MobilePack.tsx` — task-scoped pack
   workspace. RPCs (all via `enqueue`): `suggest_carton`,
   `open_pack_carton`, `assign_carton_to_pack`, `seal_pack_carton`,
   `complete_pack_task`.
2. `src/pages/warehouse-mobile/MobileDispatch.tsx` — scan carton LPNs
   onto a manifest, close, dispatch. RPCs: `load_carton_onto_manifest`,
   `close_loading_manifest`, `dispatch_loading_manifest`.
3. `src/pages/warehouse-mobile/MobileQC.tsx` — pass / fail / hold an
   inspection. RPCs: `accept_qc_inspection`, `reject_qc_inspection`,
   `cancel_qc_inspection`.
4. Router wiring in `src/apps/warehouse-mobile/routes.tsx`:
   `/wm/pack/:packId`, `/wm/dispatch/:shipmentId`, `/wm/qc/:taskId`.
5. `MobileHome` gained a Pack tile, an open-manifests section, and an
   open-QC-inspections section — all deep-linking into the new screens.
6. Guard extension in `src/test/architecture/wms-phase13.test.ts`
   asserts the three new routes are wired. `enqueue`-only RPC and
   `MobileWarehouseLayout` guards already cover the new pages by
   pattern.
7. `src/test/architecture/workspace-shell.test.ts` — added
   `warehouse-mobile` to `EXEMPT_WORKSPACES` (mobile shell uses
   `MobileWarehouseLayout`, not `PlatformShell`).

### Verification

- `bunx vitest run src/test/architecture/wms-phase` → 14 files / 60
  tests green.
- Fixed pre-existing type errors in `MobileHome.tsx`
  (`wms_count_sessions.{code,state}` and `wms_tasks.state` values).

### Guardrails held

- No direct `supabase.rpc(...)` in any mobile page.
- No client writes to `wms_*` tables.
- Desktop pages, RPCs, and `vite-plugin-pwa` config untouched.
- `MobileWarehouseLayout` remains the sole mobile shell.

---

## START HERE NEXT — Phase 14: End-to-end integration harness

The WMS surface (desktop + mobile) is feature-complete for Phases 0–13.1.
The next milestone is a *repeatable* end-to-end harness that exercises
the full receipt → putaway → wave → pick → pack → dispatch → QC path
against a seeded business, so future refactors don't silently break
cross-phase invariants.

### Scope

1. Deterministic seed script (SQL migration `is_sample_data = true`)
   creating: one warehouse, three zones/bins, two products with lots,
   one carrier, one dock, one carton type, one QC hold reason, one
   labour standard per task type.
2. Playwright suite under `e2e/wms/` driving the desktop shell:
   `receive.spec.ts`, `putaway.spec.ts`, `wave.spec.ts`,
   `pick-pack-dispatch.spec.ts`, `qc.spec.ts`, `count.spec.ts`.
3. Mobile-shell counterpart `e2e/wm/` exercising the offline queue:
   toggle offline → enqueue an action → toggle online → assert the
   queue drains and the same RPC lands server-side. Uses the injected
   Supabase session per the browser-use directive.
4. New architecture guard `wms-phase14.test.ts` asserting each spec
   file exists and covers the phase it names.

### Explicitly out of scope for Phase 14

- Any new UI. Harness only exercises what already ships.
- Load / concurrency tests (belongs to a later Phase).
- CI wiring — the harness lives in-repo; scheduling is a separate loop.

### Out of scope forever (documented deferrals)

- ASN per-line scan-driven receive on mobile (needs a new RPC variant).
- PWA manifest split for `/wm`.
- ADR 0084 (deferred with intent; see docs/adr).
