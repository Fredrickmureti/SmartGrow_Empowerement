
# Personal Relief still zero on P9 — engine-side fix

## What's happening

The P9 template bindings we shipped last round are correct. The reason
column M (Personal Relief) is still 0.00 on Fredrick Mureti's May P9 is
that the underlying payslip_lines row **does not exist** — for anyone,
on any run.

Evidence from the connected database:

- `payslips.paye_before_relief = 20,092.32` and `paye = 17,692.32`
  → engine correctly applied `personal_relief = 2,400.00`.
- `SELECT COUNT(*) FROM payslip_lines WHERE rule_code='personal_relief'`
  → **0 rows** across the entire tenant.
- `payslips.compute_breakdown -> 'bracket_traces'` is `NULL` on the May
  run, so the informational relief-line emitter in `compute-payroll`
  (which is gated on the in-memory bracket-trace map) never ran on any
  historical payroll.

ADR-0061 says the P9 matrix reads Personal / Insurance Relief only from
`payslip_lines`, so the template cannot recover this — the engine has
to write it.

## Fix (three coordinated changes)

### 1. Engine: always emit relief lines when a progressive tax rule ran

`supabase/functions/compute-payroll/index.ts`

- Stop gating relief-line emission on the `__bracket_traces_by_rule_name`
  side-map. Emit `personal_relief` / `insurance_relief` payslip_lines
  directly from the `bracketTraceSink` we already build per employee
  (same source that feeds `paye_before_relief`), so every payroll run
  going forward persists relief lines as `category='relief'`,
  `rule_type='relief'`, positive amounts, informational (do not affect
  totals).
- Keep the emission country-agnostic: driven purely by whatever
  `trace.personal_relief` / `trace.insurance_relief` the progressive rule
  reported. No literal country / rule_code branches added.
- Add a unit test in `supabase/functions/compute-payroll/` asserting
  that a run with `personal_relief=2400` produces exactly one
  `personal_relief` payslip_line of amount 2400.

### 2. Backfill: reconstruct relief lines for historical payslips

Migration `supabase/migrations/<ts>_backfill_relief_payslip_lines.sql`:

- For every payslip where `paye_before_relief IS NOT NULL` and no
  `personal_relief` payslip_line exists, insert a
  `personal_relief` line with amount = `paye_before_relief - paye_line_amount`
  (this equals the exact relief the engine deducted, since PAYE net is
  what's stored as the paye payslip_line).
- Same logic for `insurance_relief` where the trace exists on the
  payslip's `compute_breakdown`; when absent, skip (relief was 0).
- `source` JSON is stamped `{ backfill: true, from: 'paye_before_relief', adr: '0062' }`
  for provenance.
- Idempotent (`ON CONFLICT DO NOTHING` on payslip_id + rule_code).
- Ships GRANTs are unchanged — we're inserting into an existing table.

### 3. Pack bump: publish `KE 2026.5.1`

Even though the template body is unchanged, the KE pack needs a version
row so `propose-localization-upgrades` fans out an upgrade the user can
accept in-app (consistent with the D1 invariant test on migrations
that touch pack contents). The bump carries release notes explaining
"Personal Relief / Insurance Relief now sourced from persisted
payslip_lines (engine fix + backfill)".

Migration inserts:
- one row into `pack_versions` (`ke`, `2026.5.1`, status=`published`)
- companion insert into `pack_migration_log` for auditability

## Verification

After the migration runs:

1. Re-query `payslip_lines` for Fredrick Mureti's May payslip →
   expect a `personal_relief` row of 2,400.00.
2. `payroll_employee_ytd_rollup` for FY 2026 → `personal_relief` totals
   non-zero.
3. Regenerate the P9 → column M shows 2,400.00 per month, column L =
   O + M + N reconciles, footer totals update.
4. New payroll run (any month) → engine writes both `paye` and
   `personal_relief` payslip_lines without needing the backfill path.

## Out of scope

- No template body change (the ADR-0061 bindings are already correct).
- No changes to the resolver, matrix pivot, or generator refusal logic
  shipped last round.
- No country-specific logic — the engine fix is generic across any
  progressive tax rule that reports reliefs.

## Files touched

```text
supabase/functions/compute-payroll/index.ts                (edit)
supabase/functions/compute-payroll/relief-lines.test.ts    (new)
supabase/migrations/<ts>_backfill_relief_payslip_lines.sql (new, via migration tool)
supabase/migrations/<ts>_publish_ke_2026_5_1.sql           (new, via migration tool)
```
