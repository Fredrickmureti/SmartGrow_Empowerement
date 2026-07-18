# WMS end-to-end harness — operator guide

Phase 14 lands the E2E harness for the WMS receipt → dispatch path plus
the mobile offline-queue drain. This doc is the entry point for any
agent or engineer picking up Phase 14b or later.

## Layout

```
e2e/
  README.md                       # runbook (bunx playwright test …)
  support/
    auth.ts                       # restore Supabase session per spec
    seed.ts                       # ensureSeed(page) — stub until 14b
  wms/
    receive.spec.ts               # 14b
    putaway.spec.ts               # 14c
    wave.spec.ts                  # 14d
    pick-pack-dispatch.spec.ts    # 14e
    qc.spec.ts                    # 14f
    count.spec.ts                 # 14f
  wm/
    offline-drain.spec.ts         # 14g
playwright.config.ts              # two projects: `wms`, `wm`
src/test/architecture/wms-phase14.test.ts   # structure guard
```

## Running

```bash
# Dev server must already be up on :8080
bunx playwright test                # both projects
bunx playwright test --project=wms  # desktop only
bunx playwright test --project=wm   # mobile only
```

All specs currently `describe.skip(...)` — they no-op green until their
sub-phase lands. This is intentional; see `.lovable/plan.md` §14.

## Auth

Every spec calls `await restoreSupabaseSession(context, page)` before
navigating to an authenticated route. When the sandbox env vars
(`LOVABLE_BROWSER_SUPABASE_*`) are absent, the spec `test.skip()`s
itself with a clear reason — never hardcode credentials.

## Seed contract

`e2e/support/seed.ts` exposes `ensureSeed(page)`. Phase 14b replaces
the stub with a call to a `wms_e2e_ensure_seed` RPC (backed by a
`is_sample_data = true` migration). Contract:

- Idempotent — safe to call from every `beforeAll`.
- Creates: 1 warehouse, 3 zones/bins, 2 products with lots, 1 carrier,
  1 dock, 1 carton type, 1 QC hold reason, 1 labour standard per task
  type, 1 open PO + open SO for the receive/wave specs.
- Tagged so `security` scans and the outbox skip these rows.

## Extending

When adding a new WMS flow that deserves E2E coverage:

1. Add a spec under `e2e/wms/<flow>.spec.ts` (or `e2e/wm/` for RF).
2. List its RPCs in the file header AND in
   `src/test/architecture/wms-phase14.test.ts` `SPECS` table.
3. Land it under a new sub-phase in `.lovable/plan.md`.

## When 14g ships

Extend `wms-phase14.test.ts` with an additional assertion that no
`describe.skip(` remains in `e2e/**`. That flips the guard from
"scaffolding present" to "every flow green".
