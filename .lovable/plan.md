
# Tenant Transaction Reset — Audit & Remediation Plan

## Current architecture (verified by reading the code)

The subsystem is more mature than the surface symptom suggests. Confirmed pieces:

- **UI** — `src/components/settings/OrgDataResetTool.tsx`: 3-step confirmation (`warning → type_confirm → final_countdown`), preview panel, per-category and `wipe_all` modes, uses `supabase.functions.invoke("clear-org-data")` with typed body, surfaces `{stage, error, code, hint, details}` from server.
- **Edge function** — `supabase/functions/clear-org-data/index.ts` (515 LOC): five modes (`preview`, `wipe_all`, `categories`, `delete_organization`, `gc_orphans`), always returns HTTP 200 with `{ok, success, stage, error, code, hint, details}` envelope, service-role detection for pg_cron, storage GC via shared `runStorageGc`, orphan `auth.users` reaping on tenant delete, audit log writes.
- **Database** — SQL RPCs `preview_organization_reset`, `reset_organization_data`, `reset_categories`, `platform_delete_organization`; a **governance teardown context** (`app.reset_in_progress` GUC, `_is_teardown_for_org(...)`) that immutability triggers must honor — enforced by an introspection test at `supabase/tests/teardown_context_bypass_test.sql` covering 29 guard functions.

The bones of an enterprise reset engine are in place. This plan does not tear that down — it verifies it works end-to-end, then closes the gaps that make the current failure possible.

## Diagnosis approach (before touching code)

The claim "CORS failure" is treated as a symptom until proven. Actual root causes at this layer are almost always one of:

1. Edge function threw during boot/import (esm.sh drift, missing env) → no CORS headers reach browser → looks like CORS.
2. Function ran > platform timeout on a large tenant → connection reset mid-response.
3. Auth token expired → 401 without CORS headers on the error path.
4. Real CORS mismatch (unlikely — headers include the full Supabase client header set).

### Diagnostic steps (read-only, run first in build mode)

1. Deploy status + fresh boot: call `curl_edge_functions` with `mode: preview` on the current org — this exercises auth + one RPC and returns the structured envelope. If it fails, the payload's `stage`/`error`/`code` names the true fault.
2. `edge_function_logs` for `clear-org-data` — look for boot errors, `list_org_storage_paths` failures, RPC exceptions, timeout markers.
3. If preview works but `wipe_all` fails, call `wipe_all` on a scratch org and capture the failing stage.
4. Only if the envelope never reaches the browser: inspect actual CORS response headers on a manually crafted OPTIONS request.

## Enterprise correctness checklist (audit findings to confirm/close)

Verified from reading the code — each becomes a concrete remediation only if the diagnostic run shows it broken:

| Concern | Current state | Action if gap found |
| --- | --- | --- |
| Atomicity per category | `reset_categories` is transactional (per UI comment) | Verify by reading the SQL; if not wrapped in a single txn, wrap it |
| Atomicity of `wipe_all` | Runs `reset_organization_data` as one RPC (single txn) then storage purge (best-effort, post-commit) | Confirm SQL is single txn; document that storage is eventually-consistent and reconciled by `gc_orphans` |
| Immutability triggers bypass | 29 guards asserted by pg_tap test | Add any new guard authors to the test's expected list; keep the test in CI |
| Master data preservation | Enforced by RPC allow-lists inside `reset_organization_data` | Add an inverse coverage test: after wipe, assert core tables (organizations, users, roles, chart_of_accounts_templates, products, warehouses, tax config, printer/media/label templates, localization packs) are non-empty and unchanged |
| Idempotency | Confirmation token `RESET-<org_id>` prevents accidental replay; RPC itself is naturally idempotent on empty tenant | Add explicit idempotency: second run returns `{already_clean: true}` instead of no-op silent success |
| Recovery from partial failure | SQL txn rolls back cleanly; storage purge is best-effort with `gc_orphans` sweep | Ensure `gc_orphans` covers every bucket touched by `wipe_all` |
| Sequences | Confirm `reset_organization_data` resets `*_sequences` tables (invoice_sequences, je_number_sequences, payroll_number_sequences, etc.) | If missing any, add to the RPC |
| Derived state | Confirm reset clears `*_ytd`, `*_daily`, `*_summary`, cache tables (`ai_insights_cache`, `pos_daily_summary`, `payroll_employee_ytd`, `project_burndown_daily`) | Add anything missing |
| Event queues | Confirm `business_event_outbox`, `email_event_outbox`, `sms_event_outbox`, `notifications`, `webhook_events` are cleared to avoid dangling FK refs | Add if missing |
| Audit logs | Currently NOT cleared (verified — audit insert happens after wipe) — correct enterprise behavior (audit is regulatory) | Document; expose a separate platform-admin-only "purge audit" path if ever needed |
| Observability | Console-only logging in edge fn | Persist a `reset_runs` table row per attempt with `{stage, started_at, finished_at, ok, error, counts}` for support recovery |
| Long-running risk | Currently synchronous HTTP; fine for evaluation-sized tenants but not for production-scale | If diagnostic shows timeouts, promote `wipe_all` to a background job pattern: edge fn enqueues, `pg_cron`/`process-scheduled-automations` executes, UI polls `reset_runs` row |
| UI states | Only `loading`/`done`/`error` | Add explicit `preparing → validating → running → finalizing → complete` states driven by a `reset_runs` row when async path is enabled |

## Execution plan

**Phase 0 — Investigate (no code changes)**
- Run `preview`, `wipe_all` on scratch org via `curl_edge_functions`.
- Pull `edge_function_logs`.
- Read `reset_organization_data`, `reset_categories`, `preview_organization_reset` SQL bodies from a recent migration to verify allow-lists, sequence resets, derived-state clears, event-queue clears.
- Produce a short verdict: what actually failed and which checklist rows are gaps vs. already-correct.

**Phase 1 — Fix the real failure**
- Address the concrete cause identified in Phase 0 (e.g. missing table in RPC allow-list, edge-fn boot error, expired auth path). Not speculated in advance.

**Phase 2 — Close verified gaps only**
- Extend `reset_organization_data` SQL with any missing sequences / derived tables / event queues found in Phase 0.
- Add `public.reset_runs` observability table (id, org_id, mode, categories, stage, started_at, finished_at, ok, error, counts_json, initiated_by) with RLS + grants, written from the edge function.
- Add architecture test: after `wipe_all`, master-data tables are unchanged and transactional tables are empty.

**Phase 3 — UI honesty**
- Consume `reset_runs` (if added) so the UI shows the real stage instead of a single spinner.
- Ensure error toasts always render the normalized `{stage, error, hint}` — already implemented, just verify no path bypasses it.

**Phase 4 — Optional async promotion**
- Only if Phase 0 shows timeout risk: convert `wipe_all` to enqueue + background worker + poll. Otherwise leave synchronous — added complexity without benefit for evaluation-scale resets.

## Technical notes

- All schema changes go through the migration tool with proper `GRANT` + RLS.
- The teardown-context test (`teardown_context_bypass_test.sql`) is the safety net for any new immutability trigger — any new guard added in Phase 2 SQL must be added to its expected list.
- No changes to `platform_delete_organization` in scope — separate concern.
- Storage GC continues to reconcile any object the SQL path misses; do not try to make storage cleanup transactional (it can't be).

## Out of scope

- Tenant creation flow.
- Multi-region / cross-cluster replication of resets.
- Backup/restore before reset (separate feature).
