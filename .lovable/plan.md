## What I actually see in the PDF you uploaded (PAY-0069, generated 15:45:08 UTC)

Rendered deduction lines:

| Line | Amount |
|---|---|
| NSSF | 5,639.94 |
| SHIF | 2,585.00 |
| AHL | 1,410.00 |
| PAYE | 17,692.32 |
| NSSF Voluntary | 2,000.00 |
| **Sum of visible lines** | **29,327.26** |
| **"Total Deductions" printed** | **36,327.26** |
| **Silent delta** | **7,000.00** |

The 7,000 delta is exactly the child-support garnishment. Same class of bug the previous turn claimed to have fixed. It is not fixed.

## What the database actually contains for that same payslip

Payslip `15575106-c29a-4ffb-8ae7-d58a8ae11c20` in `payslip_lines`:

```
seq 8  category=post_tax_deduction  label=child_support  employee_amount=7000
       rule_code=garnishment_0dfb6e04-b7bd-4e40-9507-ec56fb370f7f
```

So the engine DID write a canonical line. The line exists. The header total is correct. The PDF simply did not render it.

## Where the divergence is (verified, not assumed)

1. `generate-payslip-pdf/index.ts:177-190` iterates `payslip_lines` and pushes anything the shared `classifyPayslipLine` buckets as `"deduction"` into the printed rows.
2. `_shared/payslipClassifier.ts` (source on disk) DOES include `post_tax_deduction` in its `DEDUCTION` set.
3. Yet the freshly-rendered PDF (15:45:08 log confirms `generate-payslip-pdf` served it) omits the `post_tax_deduction` row.

Two-file source vs runtime disagree → the deployed edge-function bundle for `generate-payslip-pdf` is running against an older snapshot of `_shared/payslipClassifier.ts` (one that did not know about `post_tax_deduction` / `garnishment`). Supabase edge functions inline `_shared/*` at deploy time; editing a shared file does NOT redeploy the functions that import it. The previous turn edited the classifier and the caller sources, but never forced a rebuild of the leaf functions. Everything downstream stayed on the pre-change bundle.

This is the architectural smell that keeps producing this bug: any renderer / GL poster / report has its own frozen copy of the classifier, and the "unified classifier" only works if every consumer is redeployed in lock-step. That is not a contract, it's a hope.

## Plan

### 1. Prove the deploy-drift theory before touching code
- Add one `console.info` at the top of `generate-payslip-pdf` bucketing loop that prints, for the target payslip: `{seq, category, bucket}` for every fetched line.
- Re-run the PDF for `15575106-…`. Read `supabase edge_function_logs generate-payslip-pdf`.
  - If `category=post_tax_deduction` logs as `bucket=info` → deployed bundle is stale (deploy-drift confirmed).
  - If it logs as `bucket=deduction` but the row is still missing → the drift is inside the row-emission loop or `reportPdfGenerator`, and I'll trace from there.

### 2. Fix the deploy-drift (root cause)
- Force a rebuild of every leaf function that imports `_shared/payslipClassifier.ts` by touching each `index.ts` with a header-comment bump:
  - `generate-payslip-pdf`
  - `generate-payroll-document`
  - `post-payroll-gl`
  - any other match `rg -l "payslipClassifier" supabase/functions | xargs -n1 dirname` returns.

### 3. Make it architecturally impossible to reproduce
The current design lets a header total be right while a line is invisible because the renderer trusts its own bundled classifier and the DB never enforces line↔header agreement. Add the guard the previous turn deferred:

- **DB trigger `payslips_totals_match_lines` (migration):** on `INSERT`/`UPDATE` of `payslips`, sum `payslip_lines` for that payslip via the SAME categorisation the engine uses (a SQL function `payslip_bucket(category text)` returning `earning|deduction|employer_contribution|info`). Reject when `gross_pay`, `total_deductions`, or the employer-contribution total disagree with the summed lines beyond a 0.01 tolerance. This makes it impossible to persist a header that lies about its lines — no engine change, no renderer change can bring the bug back.
- **SQL bucketing function is the ONE source of truth**; the TS classifiers become thin mirrors that call a shared JSON constant generated from the same table, or (simpler) an architecture test asserts the SQL `payslip_bucket` list equals the TS `EARNING`/`DEDUCTION`/`EMPLOYER` sets byte-for-byte.

### 4. Verify end-to-end
- Re-invoke `generate-payslip-pdf` for PAY-0069 (and a freshly-computed run) and confirm:
  - The child_support 7,000 row appears under DEDUCTIONS.
  - Line sum == printed `Total Deductions` == 36,327.26.
  - Removing the line in a test payload causes the DB trigger to reject the payslip write.

### Out of scope
- Not touching PAYE bracket rendering, YTD math, or the personal-relief line (that's a separate cosmetic — the relief is categorised `relief` → `info` by design, which is correct; it's already netted inside PAYE).
- Not backfilling PAY-0069's PDF — it re-renders on demand and will be correct once step 2 lands.

## Technical detail

- SQL function skeleton for the trigger:
  ```sql
  create or replace function public.payslip_bucket(cat text)
  returns text language sql immutable as $$
    select case lower(cat)
      when 'earning' then 'earning' … when 'basic' then 'earning' …
      when 'deduction' then 'deduction' … when 'post_tax_deduction' then 'deduction'
        … when 'garnishment' then 'deduction' …
      when 'statutory_employer' then 'employer_contribution' …
      else 'info' end;
  $$;
  ```
- Trigger compares `sum(employee_amount) filter (where payslip_bucket(category)='earning')` vs `payslips.gross_pay`, etc.
- Architecture test in `src/test/architecture/` reads the SQL function body and asserts every string in the TS `EARNING`/`DEDUCTION`/`EMPLOYER` sets appears in the SQL CASE — prevents future drift.
