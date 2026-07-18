# WMS end-to-end harness

Phase 14 landing zone. Two Playwright projects live here:

| Project | Folder    | Covers                                             |
| ------- | --------- | -------------------------------------------------- |
| `wms`   | `e2e/wms` | Desktop shell: receive, putaway, wave, pick-pack-dispatch, qc, count |
| `wm`    | `e2e/wm`  | Mobile RF shell: offline-queue drain               |

## Running

```bash
# Dev server must already be up on :8080
bunx playwright test                    # both projects
bunx playwright test --project=wms      # desktop only
bunx playwright test --project=wm       # mobile only
bunx playwright test e2e/wms/receive    # one flow
```

## Auth

Specs restore a managed Supabase session at page start using the
`LOVABLE_BROWSER_SUPABASE_*` env vars documented in the browser-use
directive. `e2e/support/auth.ts` centralizes this — never inline the
storage-key write inside a spec.

## Seed

`e2e/wms/*` specs run against the deterministic sample-data seed
delivered in Phase 14b (migration flagged `is_sample_data = true`).
Seeds must be idempotent — every spec calls
`await ensureSeed(page)` in its `beforeAll`.

## Status

See `.lovable/plan.md` — Phase 14 is landing sub-phase by sub-phase.
14a scaffolds this folder; 14b–14g bring each spec to green one at a
time. Skipped specs use `test.describe.skip(...)` with a "Phase 14x
pending" reason so it's obvious which flows are still stubs.
