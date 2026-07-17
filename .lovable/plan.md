# Resume: complete localization-pack deployment, then resume inventory audit

App is now published, which unblocks the delete tool. Router code + all client callers already migrated to `invokeLocalizationPack` in a prior turn. Only the deploy/delete/verify steps remain before we can deploy `stock-quant-drift` and get back to the inventory audit backlog.

## Step 1 — Verify current state (read-only)
- Confirm `supabase/functions/localization-pack/index.ts` + all 9 `ops/*.ts` exist and compile.
- Confirm no in-app caller still targets a legacy function name via `supabase.functions.invoke("install-localization-pack", …)` etc. — every path should go through `invokeLocalizationPack`.
- Confirm architecture tests point at `supabase/functions/localization-pack/ops/*`.
- Check for any pg_cron migration referencing `process-localization-outbox` that needs repointing.

## Step 2 — Free slots
Delete the 9 legacy edge functions in a single call:
`install-localization-pack`, `apply-localization-pack-upgrade`, `rollback-localization-pack-upgrade`, `propose-localization-upgrades`, `promote-pack-version`, `publish-localization-pack-version`, `lint-localization-pack`, `validate-localization-payload`, `process-localization-outbox`.

## Step 3 — Deploy
Deploy `localization-pack` router. Then deploy `stock-quant-drift` (the inventory function that was originally blocked by the slot ceiling).

## Step 4 — Verify parity via `curl_edge_functions`
For each op, one happy-path + one auth/validation failure:
- `validate` (anonymous) → 200 on valid payload, 400 on missing field.
- `promote` / `apply` / `rollback` / `publish` → 401 without auth header.
- `lint` → 200 with `{issues: [...]}` shape.
- `process-outbox` → 200 no-op envelope.
- `install` → 400 on missing `pack_id`.
- Unknown op → 400 with `code=BAD_REQUEST`.

Report byte-shape parity vs. what the legacy functions returned (envelopes are preserved verbatim in the moved ops).

## Step 5 — Cleanup
- Remove the legacy source folders `supabase/functions/<legacy-name>/` from the repo (they'll otherwise be re-deployed).
- Grep for any stragglers referencing legacy names outside of `invokeLocalizationPack.ts` (that helper intentionally keeps them as string literals for grep-continuity).

## Step 6 — Resume inventory audit
Once the slot is free and `stock-quant-drift` is deployed, pick up the inventory foundation audit at the last genuinely-completed milestone. That resumption is out of scope for this turn — this plan is scoped strictly to unblocking the deploy.

## Risks
- **Cron dependency on `process-localization-outbox`**: if a Supabase-dashboard cron (not in repo migrations) points at the legacy URL, it will 404 after deletion. Mitigation: grep migrations for `pg_cron` / `cron.schedule` referencing that name; if found in repo, patch to hit `localization-pack` with `{"op":"process-outbox"}`. If not in repo, flag to user to repoint in the dashboard.
- **Legacy source folders left in repo**: if not deleted, the next deploy cycle re-creates them and re-consumes slots. Step 5 handles this.
- **Router cold-start**: acceptable per the consolidation plan; ops share `_shared` heavily.

## Not doing
- No behavioural changes to any op logic.
- No inventory code changes this turn.
- No publish call (user already published).
