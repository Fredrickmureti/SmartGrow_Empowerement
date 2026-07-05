
# Compliance Pipeline — Investigation & Fix Plan

## 1. Architecture that already exists (verified in code)

The pack-driven compliance lifecycle is already in place; nothing here needs re-architecting:

```text
Payroll runs (approved + posted)
  └─ payslips / payslip_lines            ← immutable, country-agnostic
       └─ payroll_liabilities            ← generated on posting
            ├─ Remittances               ← post-remittance-payment
            ├─ Tax Certificates          ← generate-tax-certificate
            │     • template resolved from v_org_active_localization_pack
            │       → localization_pack_certificate_templates (pack or NULL fallback)
            │     • tenant overrides via payroll_certificate_template_overrides
            │     • YTD via RPC payroll_employee_ytd_rollup(year, employee)
            │     • provenance snapshot + payroll_tax_certificate_events ledger
            │     • download-tax-certificate → 60s signed URL
            └─ Statutory Returns         ← generate-statutory-return
                  • template from localization_pack_return_templates
                  • tokens via _shared/renderTokens.ts
                  • payroll_return_runs 8-state machine
                  • record-return-filing / submit-statutory-return
```

Dashboard: `RemittanceOperatorDashboard` → RPC `payroll_remittance_dashboard(p_organization_id, p_business_id)` (verified present, 2 uuid args).

Templates present in DB for the active pack `a1b2c3d4-…`: P9, P9A (certs) and P10, P10D, P10A, AHL_RET, NSSF_RET, SHIF_RET, NITA_RET, HELB_LR (returns). So the "P10 template missing" branch is not the failure.

## 2. Root causes

### Failure 2 — `POST /generate-statutory-return` 404
Direct probe of the deployed function returns `401 unauthenticated`, i.e. the function **is** deployed and reachable. A 404 from the browser is therefore not "function missing"; it is one of:
- the request being sent before/around a redeploy window (transient), or
- the client dispatching to a stale URL because a Supabase project reconnect happened this session (the connect step earlier in this thread rewrote `src/integrations/supabase/client.ts` and `types.ts`).

Fix: re-deploy `generate-statutory-return` from the current source and re-verify with an authenticated call from the app. If it still 404s, the client is calling the wrong project — reconcile `SUPABASE_URL` / project ref against the newly connected `AccrualFlowCorporation` project.

### Failure 1 — `POST /generate-tax-certificate` 500
The function boots cleanly (edge logs show Boot/Shutdown only, no error frames captured for the failed request). Reading the handler, the only paths that produce a raw 500 without a structured body are:
1. `permErr` from `user_has_module_permission` — but both 4-arg and 5-arg overloads exist, the 5-arg one matches the call, so this resolves.
2. `empErr` from the employees select — the projection joins `departments!employees_department_id_fkey` and `job_positions`; if the FK label or a column (e.g. `national_id`, `tax_pin`, `branch_id`) is missing in this connected project's schema, PostgREST returns an error and we surface HTTP 500 with `failed to load employees: …`.
3. `payroll_employee_ytd_rollup` throw — caught per-employee and pushed into `errors[]`, response is 200 with `errors`, so it does **not** produce a top-level 500.
4. An unhandled throw from `getOrganizationBranding`, `renderTemplateBody`, `renderCertificateSections`, `generateReportPdf`, or `assertStatutoryPaper` — caught by the outer `try/catch`, which currently returns `500` with `{ error: err.message }` (structured but generic).

The 500 in the UI has no message body surfaced in either edge logs or the console excerpt, so step 1 is to capture the actual message. Investigation order:
1. Redeploy the function, call with a real payload, read `event_message` from `supabase--edge_function_logs generate-tax-certificate`.
2. Inspect the returned JSON body in the network panel — the handler already returns `{ error: "..." }` at 500. That string is the answer.
3. Most likely candidates given this project's schema drift after re-connect:
   - `employees` select failing on `tax_pin` / `national_id` / the `departments` FK label (schema mismatch between edge function and current DB).
   - `getOrganizationBranding` failing because the `organizations`/`businesses` columns it reads differ.

### Failure 3 — `rpc(payroll_remittance_dashboard)` 400
The RPC signature matches the call (2 uuid args). A PostgREST 400 with matching signature is almost always a runtime error inside the plpgsql body being surfaced as HTTP 400. Two likely offenders:
- `payroll_liabilities` columns referenced (`authority_name`, `currency_code`, `outstanding_amount`, `status`, `due_date`) — if any is renamed/absent in this schema the function raises.
- The "returns due in next 30 days" subquery reads from filing calendar v2 (`payroll_filing_calendar_projection` / view); if the projection is unpopulated or the referenced columns changed, the RPC errors.

Fix: run the RPC directly with the org/business ids and read the SQL error; adjust the RPC (via migration) to match current column names or add a null-guard for the missing filing-calendar row set.

## 3. Investigation steps (before touching code)

1. Confirm deployment state:
   - `supabase--deploy_edge_functions generate-tax-certificate generate-statutory-return download-tax-certificate` to force fresh deploys against the newly connected project.
   - Curl each with a real auth token via `supabase--curl_edge_functions` and capture bodies.
2. Capture the actual 500 body for `generate-tax-certificate` (network tab + edge logs by `event_message`).
3. Run `payroll_remittance_dashboard` directly with the tenant's `organization_id`/`business_id` in `supabase--read_query` (wrapped in `SELECT payroll_remittance_dashboard(...)`); read the SQL error.
4. Diff the `employees`, `payroll_liabilities`, `payroll_filing_calendar_projection` schemas against what the code assumes (`information_schema.columns`).

## 4. Fixes to apply (contingent on §3 findings)

The fixes will be narrow and match the discovered cause. Expected shape:

- **A. Statutory return 404:** redeploy `generate-statutory-return`; if still 404 in-app, verify the client is pointed at the connected project's Supabase URL. No code change unless the client is mis-targeted.
- **B. Tax cert 500:** correct the offending select/projection inside `supabase/functions/generate-tax-certificate/index.ts` to match the actual columns in this DB (or add a migration that restores the expected columns/views if they were meant to exist). Preserve the pack-driven flow — no country branching, no bypass.
- **C. Dashboard 400:** ship a migration replacing `payroll_remittance_dashboard` with a body that (i) references only columns present in this schema, (ii) tolerates an empty filing-calendar projection, (iii) preserves the return signature (`jsonb`) so the client shape is unchanged.
- **D. Observability:** upgrade the outer catch in `generate-tax-certificate` and `generate-statutory-return` to log the stack + input keys to `payroll_diagnostics` before returning the 500, so the next incident is diagnosable from the DB without waiting on edge log polling.

## 5. Verification

- Curl both edge functions with a signed-in user, assert 200 and non-empty artifact for P9/P10 against a period with completed runs.
- Assert `payroll_remittance_dashboard` returns a JSONB envelope with the five arrays (may be empty) and no error.
- Confirm `payroll_tax_certificate_events` has a `generated` row and `payroll_return_runs` transitions to `generated` after the calls.
- Re-run the architecture guard tests: `tax-certificate-lifecycle.test.ts`, `template-override-coalesce.test.ts`, `engine-resolver-only.test.ts`, `no-hardcoded-country-payroll.test.ts` — none must regress.

## 6. Non-goals (explicitly out of scope)

- Rewriting the pack lifecycle (already covered by ADR-0010, 0036, 0056).
- Adding country-specific branches to any generator.
- Re-architecting the compliance dashboard beyond making its RPC succeed and its data correct.
