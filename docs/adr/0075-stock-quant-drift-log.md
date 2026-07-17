# ADR 0075 — Durable stock quant drift log

## Status
Accepted — 2026-07-17. Precondition for ADR 0076 (retiring `warehouse_stock`).

## Context
Before we can drop the legacy `warehouse_stock` aggregate table we need
production evidence that `stock_quants` never drifts from the historical
aggregate. The old in-memory `check_stock_quant_drift` counter was ephemeral,
per-request, and left no audit trail. Governance and finance need a durable
record ("we ran the drift check nightly for 30 days, zero drift") before
sign-off.

## Decision
Add `public.stock_quant_drift_runs` — a per-organization, per-run log capturing:
- run timestamp and duration,
- number of products checked and drifted rows found,
- total drift quantity and a JSON sample of the top offenders,
- status (`running` / `completed` / `failed`) and any error message.

Access:
- Signed-in members of an org can read their own org's rows.
- Only `service_role` may write (background jobs / edge functions).

Add `record_stock_quant_drift_run(...)` SECURITY DEFINER helper so the
nightly job never touches the base table directly.

## Consequences
- Runs are queryable from the app for governance dashboards.
- Retirement of `warehouse_stock` (ADR 0076) is gated on N consecutive
  zero-drift runs in this table across all active orgs.
- Follow-up: a `stock-quant-drift-nightly` edge function + `pg_cron` schedule
  will populate this table. That job requires user-scoped SQL (function URL,
  anon key) and is created out-of-band, not via migration.
