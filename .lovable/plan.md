## What just happened

The recent payroll-localization refactor exposed three separate backend mismatches:

1. **Payroll run create is not idempotent enough.** The first click reaches the server and creates the run, but the client sometimes receives/normalizes the response as a connectivity failure. A retry then collides with existing payroll uniqueness rules (`payroll_number` or regular-period unique index), so the UI shows an error even though the run exists after reload.
2. **Approval is succeeding server-side, then the UI is retrying/stale.** The run is already `approved`; a second approval attempt correctly fails with “status approved and cannot be approved,” but the UI presents that as an approval failure instead of treating it as an idempotent success.
3. **Statutory return generation is querying the wrong payroll-period column names.** The shared lifecycle gate reads `payroll_periods.period_start/period_end`, but the live table has `start_date/end_date`, causing the 500: “Could not verify payroll period status.”
4. **Tax certificate generation still reads legacy certificate scalar fields.** `generate-tax-certificate` selects/inserts `pdf_path`/`xlsx_path`; `pdf_path` still exists, but `xlsx_path` may not, and this path was not fully migrated to artifact-first behavior. It also has weak client parsing, so the UI collapses useful function payloads into “unexpected error.”

## Implementation plan

### 1. Make payroll creation idempotent and retry-safe
- Update `supabase/functions/compute-payroll/index.ts` so payroll numbering is allocated at insert time from a collision-safe database function rather than `MAX()+1` before insert.
- Add an idempotent period check immediately before insert and again when unique-constraint errors occur:
  - If a regular run already exists for the same organization, business, and period, return a structured `REGULAR_RUN_EXISTS` response with the existing run instead of throwing a generic 500.
  - If a duplicate payroll number is hit, retry allocation a small bounded number of times rather than failing the entire run.
- Add a migration to replace `public.get_next_payroll_number(_org_id)` with an advisory-lock or sequence-backed implementation so concurrent requests cannot both pick `PAY-0001`.

### 2. Make approval idempotent from the user’s perspective
- Update `public.approve_payroll_run(p_run_id)` so if the run is already `approved`, it returns the approved run instead of raising an exception.
- Keep refusals for truly invalid states such as `posted`, `paid`, `reversed`, `deleted`, etc.
- Update `src/hooks/usePayroll.ts` to refresh runs after approve and avoid showing failure copy when the approved state is already reached.

### 3. Fix statutory return lifecycle gate
- Update `supabase/functions/_shared/payrollLifecycleGate.ts` to use the live `payroll_periods.start_date/end_date` columns.
- Keep the existing behavior that absence of a period row is advisory and does not block generation.
- Verify `generate-statutory-return` still gates on approved payroll runs and then emits `payroll_return_runs.artifacts` only.

### 4. Finish certificate artifact migration
- Update `supabase/functions/generate-tax-certificate/index.ts` to stop selecting/inserting legacy `pdf_path`/`xlsx_path` fields and rely on `artifacts` as the canonical output list.
- If a PDF is produced, keep `pdf_path` populated only while the DB column still exists for backward compatibility; do not require it for success.
- Remove references to `xlsx_path` unless the live schema confirms it exists.
- Update `src/hooks/payroll/useTaxCertificates.ts` to parse structured edge-function error payloads the same way statutory returns do, so users see the actual reason instead of “unexpected error.”

### 5. Add regression guards
- Add/adjust architecture tests to lock:
  - `payrollLifecycleGate` uses `start_date/end_date`, not nonexistent `period_start/period_end` on `payroll_periods`.
  - `generate-tax-certificate` does not depend on dropped/non-canonical certificate scalar fields.
  - Payroll approval treats already-approved as idempotent.
  - Payroll creation handles unique collisions as structured, recoverable responses.

### 6. Deploy and verify
- Apply the database migration.
- Deploy `compute-payroll`, `generate-statutory-return`, and `generate-tax-certificate`.
- Use recent logs and direct edge-function calls where possible to verify the failures move from 500/generic to structured outcomes, and that generation works against the approved April run.