# Payroll Posting Preview — HTTP 500 Root-Cause Report

## Investigation

**Business event under test:** "Payroll Posting Preview" on an Approved
Payroll Run. It is a read-only projection of the JE that a real Post-to-GL
would produce. It must not mutate accounting, payroll or finance state.

**Execution path traced:**

```
PayrollPostingPreviewDialog (dry_run:true)
  → supabase.functions.invoke("post-payroll-gl")
    → auth / entitlement / permissions
    → fetch payroll_runs
    → SoD gate                 [skipped when dry_run]
    → existing-JE detection    [warning only when dry_run]
    → fiscal period lock check [warning only when dry_run]
    → fetch payslips
    → fetch payslip_lines      ← FAILS HERE
    → payroll_required_gl_mappings_for_run
    → binding resolver → build GL lines
    → dry_run branch: return { lines, totals, warnings, ... }
```

Edge logs confirm execution reaches `step: sod (skipped for dry_run)` and
then silently returns 500 with **no** downstream logs (no
`required mappings rpc`, no `Post payroll GL error` from the outer catch).
Everything between those two markers is the failure window.

## Root cause

`post-payroll-gl` reads `payslip_lines` with:

```ts
.from("payslip_lines")
.select("rule_code, label, category, employee_amount, employer_amount, details, accounting_tag")
```

but `public.payslip_lines` has **no `details` column**. Its provenance
column is `source` (jsonb) — that is what `compute-payroll` writes into
via `pushLine(...source: finalSource)` at
`compute-payroll/index.ts:3327`.

Confirmed against the live schema:
`id, organization_id, business_id, payslip_id, payroll_run_id,
employee_id, rule_code, rule_type, category, label, sequence,
employee_amount, employer_amount, taxable, rule_version_id,
rule_version_hash, source, created_at, statutory_rule_id, accounting_tag,
calc_basis, statutory_reference` — no `details`.

PostgREST rejects the select with "column does not exist"; the reader
catches `linesError` and returns HTTP 500 with
`"Could not load payslip_lines for posting: …"`. Because both the
production post and the preview share the same reader, the write path
would fail identically — the preview simply surfaces it first.

Downstream, the same file also **reads** `line.details.garnishment_id`
and `line.details.source === "custom_deduction"` in the aggregators
(lines 370, 389). Even if the SELECT is fixed, those consumers point
at a field the producer never populated — every garnishment and custom
deduction line would silently drop out of the projected JE.

## Architectural findings

1. **Preview and post correctly share ONE journal builder** (this is the
   right pattern — SAP/Workday/Oracle all project the JE the exact same
   way they would post it) and the boundary described in
   ADR-0057 (`dry_run` short-circuits before every write) is intact:
   preview does not insert `journal_entries`, `payroll_liabilities`,
   `payroll_runs.status`, or `payroll_liability_sources`. The only
   preview-side write is a non-financial `audit_logs` row
   (`action = 'payroll_posting_previewed'`) — an intentional,
   traceability-only side effect matching enterprise practice.
2. **The real defect is a producer/consumer contract drift** on
   `payslip_lines`: compute-payroll writes provenance to `source`;
   post-payroll-gl reads `details`. The two paths were allowed to drift
   because no architecture guard pins the shared column name.
3. `details` is a legacy name from an earlier iteration; the canonical
   name is `source` (documented on the table and in
   ADR-0042 payroll-work-entries-single-projector).

## Fix (minimal, root-cause)

Align `post-payroll-gl` with the authoritative `payslip_lines.source`
column:

1. `supabase/functions/post-payroll-gl/index.ts`
   - Change the `.select(...)` on `payslip_lines` to read `source`
     instead of `details`.
   - In the garnishment aggregator, read
     `line.source?.garnishment_id` instead of
     `line.details?.garnishment_id`.
   - In the custom-deduction aggregator, read
     `line.source` as the provenance object (same shape: `{ source:
     "custom_deduction", deduction_type_id, gl_liability_account_id,
     gl_expense_account_id }`).
   - Do NOT touch the `details:` field used for `previewWarnings` on
     line 203 — that's the preview warning payload, unrelated.

2. Add a small architecture guard test
   `src/test/architecture/payslip-lines-provenance-column.test.ts` that:
   - Fails if `post-payroll-gl/index.ts` selects `details` from
     `payslip_lines`.
   - Fails if `compute-payroll/index.ts` inserts a `details` key into
     `payslip_lines` rows.
   This locks the producer/consumer contract so this class of drift
   cannot silently return.

3. Re-verify the preview end-to-end via
   `supabase--curl_edge_functions` on the same run
   (`bd8ba726-…`) with `dry_run: true` and confirm the response now
   contains `lines[]`, `total_debits`, `total_credits`, `balanced` and
   any `warnings[]` (period_closed / already_posted) — with **zero**
   new rows in `journal_entries`, `payroll_liabilities`, or a status
   change on `payroll_runs`.

## Scope explicitly NOT changed

- The preview/post boundary in ADR-0057 is already correct — no
  re-architecture is warranted.
- The dialog UI (`PayrollPostingPreviewDialog`) already renders lines,
  totals, balanced/unbalanced, warnings, and account labels — no UI
  redesign needed to satisfy the "meaningful accounting information"
  requirement once the reader returns data.
- No schema change: `source` is the correct, existing column.

## Deliverables

- Edit `supabase/functions/post-payroll-gl/index.ts` (3 references).
- Add architecture guard test.
- Verify via edge-function curl and logs.
