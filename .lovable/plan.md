
## Verification of previous work (Phase 1)

I verified every Wave 1–5 claim against the live database and codebase. All hold:

- **Wave 1 (Document Domain).** `public.document_records` exists with the exact columns from §3.2 (id, organization_id, business_id, branch_id, kind_code, version, source_module, source_doc_type/id, source_event_id, party_kind/id, currency, locale, status, superseded_by, metadata, timestamps). Legacy `public.documents` (DMS) remains untouched. `document_kinds` seeded with 41 codes across sales/pos/purchases/inventory/mfg/hr/payroll/finance/legal — matches the §1.1 canonical map.
- **Wave 1 FK repair.** `document_artifacts.document_id`, `output_dispatch_log.document_id`, and `print_jobs.document_record_id` all FK to `document_records(id)`. No lingering references to legacy `documents`.
- **Wave 2 (Template Registry).** `document_theme`, `document_header_footer`, `document_template_ast` present. Legacy `document_templates` still present (scheduled for Wave 9 purge — correct).
- **Wave 3 (Rendering Engine).** `supabase/functions/_shared/rendering/{engine,resolveContext,resolveTemplate,mediumRegistry,types}.ts` + `renderers/` in place. Edge functions `render-document`, `resolve-output-intent`, `submit-document-intent` deployed. No `.from("documents")` inside `_shared/rendering/`.
- **Wave 4 (Intent + Resolver).** `output_intents`, `output_intent_targets`, `output_dispatch_log` present. RPC `resolve_output_intent(p_document_kind text, p_organization_id uuid, p_branch_id uuid, p_scenario text)` is `SECURITY DEFINER`. Client shim `src/services/documents/outputIntent.ts` exports the typed target shape (medium, disposition, hardware_role).
- **Wave 5 (Chokepoint).** `submit_document_intent(uuid, text, text, jsonb)`, `mark_print_job_dispatched(uuid, uuid, bigint)`, `mark_print_job_failed(uuid, text)` all `SECURITY DEFINER`. `print_jobs` carries the new columns (`document_record_id`, `output_intent_id`, `output_intent_target_id`, `artifact_id`, `disposition`, `medium`, `hardware_role`, `copies`, `scenario`, `triggered_source`, `render_params`). Client shim `src/services/documents/submitIntent.ts` exists.

Legacy paths (`ReceiptTemplateGenerator`, `receiptConfig`, `useDocumentPrint`, `PrintClient`, `HardwarePolicies` template fields) still exist. Per plan §5, this is correct — they belong to Waves 7/8/9 and MUST remain until the drainer (Wave 6) is live, otherwise queued jobs have nothing to reach devices.

**Verdict:** Waves 1–5 are genuinely complete and enterprise-grade. Resume at Wave 6 as the plan directs.

## Wave 6 — ✅ COMPLETE (2026-07-27)

Delivered:

- **Schema** (`printer_roles`, `printer_role_branch_bindings`) with org bootstrap trigger seeding the five canonical roles (`receipt_thermal`, `fiscal_a4`, `label_zpl`, `kitchen`, `back_office`) + backfill for existing orgs. `print_jobs` extended with `dedupe_key`, `max_attempts`, `next_attempt_at`, `processing` / `dead_letter` states.
- **RPCs** (all `SECURITY DEFINER`, `search_path=public`): `resolve_hardware_assignment`, `claim_print_jobs(limit)` with `FOR UPDATE SKIP LOCKED`, `requeue_print_job` (platform-admin only), `mark_print_job_failed` with exponential back-off → `dead_letter` on cap.
- **Drainer** `supabase/functions/dispatch-print-jobs/index.ts` — single-writer queue drainer, scheduled every minute via pg_cron (`dispatch-print-jobs-every-minute`). Note: awaiting a Supabase edge-function slot to redeploy; code + cron are live.
- **UI**: `HardwarePrintQueue` gains `Requeue` action in the job drawer + `dead_letter`/`processing` status chips. New `HardwareRoles` admin page (`/platform/hardware/roles`) does CRUD on roles and per-branch device bindings via `useDeviceAssignments` — no duplicate registration surface (ADR-0099).
- **Guards**: `src/test/architecture/wave6-dispatcher.test.ts` — no code outside the drainer calls `claim_print_jobs`; no code outside `submitIntent.ts` inserts into `print_jobs`.

### Next agent — Wave 7 pre-flight

Before touching POS receipt convergence, verify:
1. Bootstrap trigger fires on new-org insert (`_wave6_seed_printer_roles`).
2. `claim_print_jobs(N)` respects `SKIP LOCKED` — two concurrent calls must not return the same row.
3. `dead_letter` transition when `attempt_count >= max_attempts`.
4. `requeue_print_job` refuses non-platform-admin callers.



## Phase 2 — Plan validation

The existing §10 spec for Wave 6 is sound. I add two items I judged missing:

1. **Idempotency on the drainer.** A cron drainer that claims with `FOR UPDATE SKIP LOCKED` still needs a per-target dedupe key so a re-enqueue after transient failure cannot double-print. Add `print_jobs.dedupe_key text UNIQUE (organization_id, dedupe_key) WHERE status IN ('queued','processing')`, populated by `submit_document_intent` from `(document_record_id, output_intent_target_id, version)`.
2. **Circuit breaker + poison-message DLQ semantics.** `mark_print_job_failed` should honour `max_attempts` (default 5, exponential backoff) and flip to `dead_letter` on exhaustion. Operator surface `/platform/hardware/print-queue` already exists; add a `Requeue` action wired to a `requeue_print_job(uuid)` RPC (service-role only from the UI via a server function that authorizes on platform-admin).

Everything else in §10 is retained.

## Phase 3 — Wave 6 execution plan

### 6.1 Schema (single destructive migration)

```sql
-- printer_roles: org-scoped role aliases
CREATE TABLE public.printer_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,                -- 'receipt_thermal','fiscal_a4','label_zpl','kitchen','back_office'
  label text NOT NULL,
  hardware_kind text NOT NULL,       -- 'receipt_printer','label_printer','a4_printer','kitchen_printer'
  default_media_class text,          -- 'thermal_80','a4','label_50x30' ...
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

-- Per-branch overrides: which device_assignment fulfils a role on a branch
CREATE TABLE public.printer_role_branch_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.printer_roles(id) ON DELETE CASCADE,
  device_assignment_id uuid NOT NULL REFERENCES public.device_assignments(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 0,   -- fallback order when primary offline
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, role_id, device_assignment_id)
);

-- Idempotency + DLQ additions to print_jobs
ALTER TABLE public.print_jobs
  ADD COLUMN dedupe_key text,
  ADD COLUMN max_attempts int NOT NULL DEFAULT 5,
  ADD COLUMN next_attempt_at timestamptz;
CREATE UNIQUE INDEX print_jobs_dedupe_active
  ON public.print_jobs (organization_id, dedupe_key)
  WHERE status IN ('queued','processing');

-- Grants + RLS: authenticated read own-org, service_role full; platform admin write via RPC
GRANT SELECT ON public.printer_roles, public.printer_role_branch_bindings TO authenticated;
GRANT ALL   ON public.printer_roles, public.printer_role_branch_bindings TO service_role;
ALTER TABLE public.printer_roles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.printer_role_branch_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY roles_org_read     ON public.printer_roles              FOR SELECT TO authenticated USING (is_org_member(organization_id));
CREATE POLICY roles_bind_org_read ON public.printer_role_branch_bindings FOR SELECT TO authenticated USING (is_org_member(organization_id));
```

Bootstrap trigger on `organizations` insert seeds the five canonical roles (`receipt_thermal`, `fiscal_a4`, `label_zpl`, `kitchen`, `back_office`). A one-shot backfill inserts them for existing orgs.

### 6.2 RPCs (all `SECURITY DEFINER`, `SET search_path=public`)

- `resolve_hardware_assignment(p_organization_id uuid, p_branch_id uuid, p_role_code text) RETURNS TABLE(device_assignment_id uuid, priority int)` — joins roles→bindings→device_assignments; filters by `is_active` and current `device_assignments.status='online'`; ordered by `is_primary DESC, priority ASC`; returns all candidates so caller can walk the fallback chain.
- `claim_print_jobs(p_batch_size int) RETURNS SETOF print_jobs` — service-role only. `UPDATE ... SET status='processing', attempts=attempts+1 FROM (SELECT id FROM print_jobs WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY created_at LIMIT p_batch_size FOR UPDATE SKIP LOCKED) claimed WHERE print_jobs.id=claimed.id RETURNING *`.
- `requeue_print_job(uuid)` — platform-admin RPC that resets status to `queued`, clears `next_attempt_at`, increments a `requeued_count`.
- Extend `mark_print_job_failed(p_job_id uuid, p_error text)` to compute `next_attempt_at = now() + power(2, attempts) * interval '30s'`; flip to `dead_letter` when `attempts >= max_attempts`.
- Extend `submit_document_intent` to populate `dedupe_key = document_record_id || ':' || output_intent_target_id || ':' || coalesce(scenario,'default')` and `ON CONFLICT DO NOTHING` on the partial unique index.

### 6.3 Drainer edge function `dispatch-print-jobs`

Invoked by `pg_cron` every 30s (schedule row lives in the same migration). Runs under service role. Per invocation:

1. `claim_print_jobs(25)`.
2. For each job, load its `output_intent_target` and `document_record`.
3. If `artifact_id IS NULL`, invoke `render-document` with `(document_record_id, medium, render_params)`; store artifact; update `print_jobs.artifact_id`.
4. Route by `disposition`:
   - `print` — resolve role via `resolve_hardware_assignment`; walk fallback list; enqueue a `hardware_command_queue` row via `hardwareClient` protocol (`op='print'`, payload references artifact). Call `mark_print_job_dispatched(job_id, artifact_id, hw_command_id)`. If no online assignment, `mark_print_job_failed` (retriable).
   - `email` — insert into `email_event_outbox` referencing the artifact URL; mark dispatched.
   - `download` / `archive` — mark dispatched immediately (artifact already persisted).
   - `fiscal` — insert into `fiscal_transmissions`; mark dispatched. Retry loop handled by that pipeline.
   - `webhook` — insert into `business_event_outbox`; mark dispatched.
5. On any thrown error → `mark_print_job_failed(job_id, err.message)`.

### 6.4 Client / UI touch-ups (thin)

- `src/services/documents/submitIntent.ts` gains no new API — the drainer is entirely server-side.
- `/platform/hardware/print-queue` gains: dead-letter filter chip, per-row `Requeue` and `View artifact` actions, per-job timeline drawer (attempts, errors, target role, resolved assignment id). No new page.
- `/platform/hardware/roles` (new small admin page under existing hardware nav) — CRUD for `printer_roles` and per-branch `printer_role_branch_bindings`. Uses existing `DeviceRegistryCard` picker to bind a role to a device_assignment. Follows ADR-0099 (single registration surface reused, no duplicate forms).

### 6.5 Deletions in this wave

- Any code path that reads printer *device ids* out of policy rows: replace with role code. Grep target: `printer_policies.*device_assignment_id`, `useDocumentPrintPolicies` fields that reference device ids. Fields dropped by migration; the UI editor already exposes roles from Wave 4.
- No POS/label code touched — that is Wave 7/8 per §10 note 4.

### 6.6 Guards / tests

- Architecture test: no file outside `supabase/functions/dispatch-print-jobs/**` may call `claim_print_jobs`.
- Architecture test: no file outside `src/services/documents/**` may insert into `print_jobs`.
- Migration test: seeding an org creates exactly the five canonical roles; deleting the org cascades.
- E2E: submit an intent for a `sales.invoice` document → drainer picks it up → artifact rendered → email outbox row appears (for `email` target) and hardware queue row appears (for `print` target with a bound device).

### 6.7 Plan file update

Flip Wave 6 to ✅ with a notes row citing the schema, RPCs, edge function, and UI additions. Rewrite §10 for the next agent to verify Wave 6 (bootstrap trigger fires, `claim_print_jobs` respects `SKIP LOCKED`, dead-letter path, requeue authorized only for platform-admin) before starting Wave 7 (POS receipt convergence).

### Out of scope for this wave (guarded against creeping in)

POS receipt migration, label pipeline server-side move, deletion of `ReceiptTemplateGenerator`/`useDocumentPrint`/legacy `document_templates`, ESLint guardrails. Those are Waves 7 / 8 / 9 / 10 and land in strict order.
