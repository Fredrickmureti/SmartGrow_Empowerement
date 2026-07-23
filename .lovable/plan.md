
## Diagnosis (verified against DB + code)

Traced PAY-0065 (Kimathi Mureti) end-to-end. Two independent architectural drifts, both confirmed:

### Drift 1 — Renderer has its own private category set

`supabase/functions/generate-payroll-document/index.ts` (lines 106-110) declares a **local** `DEDUCTION_CATS` set:

```ts
const DEDUCTION_CATS = new Set([
  "deduction", "statutory_employee", "tax", "loan_repayment", "benefit_recovery",
]);
```

This omits `post_tax_deduction`, `pre_tax_deduction`, `income_tax`, `voluntary_deduction`, and `garnishment`. The canonical classifiers do include them:

- `supabase/functions/_shared/payslipClassifier.ts`
- `src/lib/payroll/payslipClassifier.ts` (browser mirror)

Verified in DB: payslip `a661a090-…` has line
`{category: "post_tax_deduction", rule_code: "garnishment_0dfb6e04…", label: "child_support", employee_amount: 7000}`
at sequence 8. The line exists. `generate-payroll-document` filters it out because its private set doesn't include `post_tax_deduction`. The other PDF path (`generate-payslip-pdf/index.ts`) correctly uses `classifyPayslipLine` and would render it — proving the canonical classifier is right and the renderer is the divergence.

### Drift 2 — Header totals bypass payslip_lines entirely

`supabase/functions/compute-payroll/index.ts:3917`:

```ts
const empTotalDeductions =
  Object.values(deductionsDetail).reduce((s, v) => s + v, 0) + customEmployeeDeductionTotal;
```

`payslips.total_deductions`, `net_pay`, `gross_pay`, and `total_employer_contributions` are computed from the **parallel** in-memory `deductionsDetail` / `contributionsDetail` maps and then persisted on the header. `payslip_lines` are built independently from `garnishmentLineMeta`, `customDeductionLineMeta`, etc. Nothing enforces `sum(payslip_lines) == header total`.

DB confirms the divergence today:
- Header `total_deductions = 36,327.26` = NSSF 5,639.94 + SHIF 2,585 + AHL 1,410 + PAYE 17,692.32 + NSSF-Voluntary 2,000 + **garnishment 7,000**
- PDF renders NSSF + SHIF + AHL + PAYE + NSSF-Voluntary = 29,327.26 and the header total 36,327.26 side-by-side. The 7,000 gap is Drift 1.

Any future deduction path that increments `deductionsDetail` without a matching `pushLine(...)` (or vice versa) will re-open this class of bug silently. Legal Orders are the canary; the architecture is the wound.

## Objective

Make it structurally impossible for a payroll header total to disagree with the sum of the payslip_lines that back it, and impossible for a renderer to silently drop a category. Legal Order will then render as a natural consequence — not because we hard-coded it anywhere.

## Changes

### 1. One classifier, everywhere (fixes Drift 1)

- Delete `EARNING_CATS` / `DEDUCTION_CATS` / `EMPLOYER_CATS` from `supabase/functions/generate-payroll-document/index.ts`.
- Replace the three filters at lines 213-215 (and the summary loop at 326-328, and 270) with `classifyPayslipLine` from `supabase/functions/_shared/payslipClassifier.ts`.
- Add an architecture guard test `src/test/architecture/single-payslip-classifier.test.ts` that greps every file under `supabase/functions/**` and `src/**` and fails if any file other than the two canonical `payslipClassifier.ts` files declares a `Set<string>` literal containing `"statutory_employee"` (proxy for "someone re-invented category buckets").

### 2. Header totals derived from lines (fixes Drift 2)

Inside `compute-payroll/index.ts`, after `lineRows` is fully built for an employee and *before* `payslipsData.push({...})`:

- Compute `empTotalDeductions`, `empTotalEmployerContributions`, and the earnings portion of `grossPay` by summing `lineRows` via `classifyPayslipLine`. The existing `deductionsDetail` / `contributionsDetail` maps are demoted to *breakdown metadata* only (stored as `deductions_detail` JSON for reports) — they no longer feed totals.
- Add an assertion: `Math.abs(fromLines - fromDict) < 0.01`. If it trips, throw `PAYSLIP_LINES_TOTAL_MISMATCH` with the diff — this catches any future forked pipeline immediately in dev/staging.
- Reimbursement add-back to `storedGrossPay` / `storedNetPay` (line 4332-4333) stays, because a reimbursement `earning` line is already emitted at 4181.

### 3. Database-level guard (defense-in-depth, mirrors ADR-0022 pattern)

Add a migration that installs a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `payslips`:

- `_payslip_assert_totals_match_lines(payslip_id)` — SECURITY DEFINER, sums `payslip_lines` grouped via the same rule set the classifier uses, rejects with `payslip_total_mismatch` if `total_deductions`, `total_employer_contributions`, or `gross_pay` differ from the aggregate by more than one cent.
- Attached AFTER INSERT OR UPDATE OF (`gross_pay`, `total_deductions`, `net_pay`, `total_employer_contributions`) on `payslips`, deferred so `compute-payroll` can insert header then lines in one transaction.
- Skipped for correction-run delta payslips (`retro_of_payslip_id IS NOT NULL`) — ADR-0045 explicitly stores signed deltas; the guard would need to be delta-aware. Track that follow-up in a comment on the trigger; not in scope here.

This turns the drift into a runtime failure at the table tier, exactly like ADR-0022 did for GL mappings. UI upserts, future RPCs, ad-hoc scripts — all subject to the same check.

### 4. Kill the opaque `garnishment_<uuid>` header key

`deductions_detail` currently stores `"garnishment_0dfb6e04-…": 7000` on the header — unreadable in reports and unresolvable without joining back to `legal_orders_records`. In the same edit, replace with the human label (`"child_support"` or `"Child support (CASE-…)"`) already computed for `garnishmentLineMeta`. The stable per-line join key remains on `payslip_lines.source.garnishment_id`.

### 5. Regenerate PAY-0065

Trigger `compute-payroll` in `run_mode='reissue'` (or delete + recompute the already-frozen payslips) for the affected run so the header re-derives, the trigger validates, and the PDF picks up the shared classifier. No manual PDF patching, no hand-inserted lines — the fix is upstream.

## Out of scope

- Any change to the garnishment engine (`_shared/garnishment-engine.ts`) or `legal_orders_records` — the engine's output is correct and already emits a canonical `post_tax_deduction` line.
- Reworking correction/retro delta accounting (ADR-0045) — the new trigger explicitly exempts `retro_of_payslip_id`.
- Refactoring `deductionsDetail` / `contributionsDetail` out of existence — they stay as breakdown JSON so existing reports don't break; they just stop being the source of truth for totals.

## Tests

- `src/test/architecture/single-payslip-classifier.test.ts` — guard 1.
- `src/test/architecture/payslip-header-totals-derived-from-lines.test.ts` — greps `compute-payroll/index.ts` for `Object.values(deductionsDetail).reduce` in a `total_deductions:` context and fails the build.
- `supabase/tests/payslip_totals_match_lines_trigger_test.sql` — pgTAP: insert a payslip with a mismatched `total_deductions`, expect `payslip_total_mismatch`; insert a matched one, expect success; insert a `retro_of_payslip_id`-tagged mismatch, expect success (exemption).
- Existing `src/test/payroll/payslip-classifier.test.ts` extended with a case pinning `post_tax_deduction → deduction`.

## Rollback

- Migration reversible (`DROP TRIGGER`, `DROP FUNCTION`).
- Code changes are contained to two edge functions + one migration + tests; reverting the diff restores the pre-fix behaviour without data loss.
