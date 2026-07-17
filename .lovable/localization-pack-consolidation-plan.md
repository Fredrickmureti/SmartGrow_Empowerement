# Localization Pack Edge Function Consolidation — Execution Plan

**Goal:** Collapse 9 localization edge functions into a single router `localization-pack` with modular ops. Free ~8 edge-function slots. Zero behavioural regression.

## Scope

| Legacy function | Lines | Auth model | New op key | Client caller(s) |
|---|---:|---|---|---|
| `validate-localization-payload` | 105 | anonymous (service-role read only) | `validate` | `src/features/localization/hooks.ts` |
| `promote-pack-version` | 134 | `requireAuthenticatedUser` | `promote` | `usePack.ts` (`usePromotePackVersion`) |
| `rollback-localization-pack-upgrade` | 75 | `requireAuthenticatedUser` + user-scoped client | `rollback` | none in-app yet (H3 tool) |
| `apply-localization-pack-upgrade` | 64 | `requireAuthenticatedUser` + user-scoped client | `apply` | `usePack.ts` (`useDecidePackUpgradeProposal`) |
| `propose-localization-upgrades` | 96 | bespoke (auth + `is_platform_admin`) | `propose` | none in-app; admin tool |
| `process-localization-outbox` | 188 | anonymous / cron | `process-outbox` | pg_cron / manual |
| `install-localization-pack` | 477 | bespoke rich classifier | `install` | 5 callers (Setup, Prompt, PayrollSetupGuideDialog, AdminOrgLocalization, LocalizationPackSettings) |
| `lint-localization-pack` | 439 | anonymous (service-role) | `lint` | none direct; publish calls in-process | 
| `publish-localization-pack-version` | 378 | `requirePackPublisher` | `publish` | `usePack.ts` (`usePublishPackVersion`) |

Total: **~1956 lines**, **9 functions → 1**, net **-8 slots** (freeing 5 above the +1 needed for `stock-quant-drift`).

## Contract preservation

- Router dispatches by `body.op` (string). If absent, returns `BAD_REQUEST` with `code=OP_REQUIRED`.
- Every op module receives the raw `Request` and returns a raw `Response` — no wrapping — so status codes, headers, CORS, and body shapes are byte-identical to today.
- CORS: router uses `localizationCorsHeaders` (superset of `corsHeaders`) so every existing preflight succeeds.
- Auth: each op continues to run its own gate. The router does NOT centralize auth because auth models differ (see table).
- Error envelope: unchanged per op. `invokeLocalizationFn` and `formatInstallerError` continue to work without modification.

## Codebase layout

```
supabase/functions/localization-pack/
  index.ts                    # ~120 lines: CORS, op dispatch, unknown-op 400
  ops/
    validate.ts               # ex validate-localization-payload
    promote.ts
    rollback.ts
    apply.ts
    propose.ts
    process-outbox.ts
    install.ts
    lint.ts                   # exports handleLint(req) AND lintPack(sb, packId) so publish reuses in-process
    publish.ts                # imports lintPack() directly — no HTTP hop
  README.md                   # router contract + op index
```

Each `ops/*.ts` exports `export async function handle(req: Request): Promise<Response>`. Logic is moved verbatim from the current `Deno.serve((req) => {...})` bodies — only the outer `Deno.serve(...)` wrapper is stripped.

## Phased execution (with verification gates)

### Phase A — Scaffold + small ops (validate, promote, rollback, apply)
- Create router skeleton + 4 op modules.
- Router deployed under name `localization-pack`.
- Update `usePack.ts` for `promote` and `apply`; update `hooks.ts` for `validate`.
- Verify via `curl_edge_functions`: happy-path + one auth failure per op.
- **Do NOT delete legacy functions yet.** Legacy endpoints stay live.

### Phase B — Mid-tier ops (propose, process-outbox, install)
- Move ops.
- Update the 5 install callers to point at router.
- Verify: install a KE pack against a test business; poll outbox; run propose against KE latest.

### Phase C — Heavy ops (lint, publish) with in-process linking
- Move `lint.ts` — export both `handle` and pure `lintPack(sb, packId): Promise<string[]>`.
- `publish.ts` calls `lintPack(sb, packId)` directly (no HTTP hop; identical validation set).
- Update `usePack.ts` for `publish`.
- Verify: dry-run publish flow against KE pack, confirm same 422 payload shape for a seeded lint break.

### Phase D — Deprecate + delete
- Search+destroy any remaining references to legacy function names.
- Update 10 architecture tests to point at `supabase/functions/localization-pack/ops/<op>.ts`.
- Deploy router at final commit.
- `supabase--delete_edge_functions` for the 9 legacy functions.
- Deploy `stock-quant-drift` (slot is now free).
- Update the `install-localization-pack-callers` architecture test to ban raw invokes of the router without a valid `op`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Router hides logs behind a single function name | Every op logs with a `[localization:<op>]` prefix. |
| Cold start regression on infrequent ops | Router import graph pulls in all 9 op modules eagerly on first hit; cold path is amortised. Acceptable — ops share `_shared` heavily today. |
| Architecture tests hardcoded to legacy paths | Phase D updates them; assertions preserved verbatim. |
| pg_cron entries pointing at `process-localization-outbox` | None found in migrations. If a Supabase-dashboard cron exists (not in repo), user must repoint it to `localization-pack` with `{"op":"process-outbox"}`. Called out in Phase D message. |
| A rollback need mid-refactor | Legacy functions stay live through Phases A–C. Only Phase D removes them, and only after end-to-end verification. |

## Success criteria

1. All 9 legacy functions deleted.
2. `stock-quant-drift` deployed.
3. All architecture + unit tests pass.
4. Manual curl verification for each op returns byte-identical body shape vs legacy (auth, validation, happy).
5. No new duplicated code — `lintPack` shared, not copied.
