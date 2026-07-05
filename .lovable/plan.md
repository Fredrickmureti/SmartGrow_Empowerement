## Enterprise payroll compliance audit — verdict

The current tenant is not the problem.

Live data shows the April 2026 payroll run is already approved and GL-posted:

```text
payroll_runs.status        = posted
payroll_runs.approved_at   = present
payroll_runs.posted_at     = present
posting_status             = posted
payment_status             = pending
payslips.status breakdown  = { approved: 1 }
```

So the remaining disabled Generate buttons for **NSSF/NSSG Monthly Byproduct** and **SHIF Monthly Byproduct** are not caused by an unapproved run or pending payslip. They are caused by template lifecycle drift:

```text
P10/P10A/P10D filters:   approved | validated | paid   => works
NSSF_RET filters:        validated | paid              => blocks approved payslip
SHIF_RET filters:        validated | paid              => blocks approved payslip
```

That is an architectural inconsistency. In an enterprise payroll model, statutory return documents are generated from finalized payroll results/liabilities after payroll approval. Employee payment and authority payment are separate downstream settlement workflows. They may affect remittance/payment status, not whether the statutory schedule can be generated.

## Business-event lifecycle verdict

```text
Employee/Contract
  -> Payroll Calculation
  -> Payroll Approval / Finalization
       produces immutable payroll results, approved payslips, YTD balances, liabilities
       unlocks reports, tax certificates, statutory returns
  -> Parallel downstream workflows:
       GL Posting
       Employee Payment
       Bank File
       Payslip Issue
       Statutory Return Generation
       Tax Certificate Generation
       Remittance/Authority Payment
       Filing/Acknowledgement
```

The accepted architecture in `ADR-0058` is correct: downstream workflows are peers after Approval, not a linear chain. The implementation partially follows it, but several dependencies still deviate.

## Architectural disconnects discovered

1. **NSSF/SHIF return templates still model payment as a generation gate**
   - `localization_pack_return_templates.body.filters.payslip_status` for NSSF/SHIF excludes `approved`.
   - This contradicts the approved-run statutory lifecycle and creates the exact disabled button seen in the tenant.
   - Verdict: **deviation**.

2. **The regression test currently encodes the wrong business rule**
   - `return-template-filter-legal-basis.test.ts` classifies NSSF/SHIF as cash-basis and forbids `approved`.
   - That test would reintroduce the same defect for every new tenant/pack.
   - Verdict: **test is architecturally wrong and must be rewritten**.

3. **P9 monthly breakdown still filters to `validated | paid`**
   - `payroll_employee_monthly_breakdown` uses `ps.status IN ('validated', 'paid')`.
   - P9 generation itself gates on approved runs, but the monthly grid can silently omit approved payslips.
   - Verdict: **hidden certificate data-quality bug**.

4. **Return generation and UI preflight both enforce template `payslip_status` filters**
   - This is correct mechanically, but pack data is wrong for NSSF/SHIF.
   - The template registry is therefore a runtime dependency, not static content.
   - Verdict: **dependency chain is correct, source metadata is inconsistent**.

5. **P10 regeneration 500 is a separate robustness failure**
   - Existing P10 rows are present for April 2026 and reconciliation is `breach`.
   - The edge function returns raw 500 for supersede/insert/storage/state-machine failures instead of structured business errors.
   - The existing run state machine allows `generated -> superseded`, so the likely failure is in the regeneration path after or around supersede/insert/storage, but current logs do not expose the exact branch.
   - Verdict: **error handling and idempotency/supersede flow are not enterprise-grade**.

6. **`payroll_remittance_dashboard` 400 appears historically fixed in DB shape**
   - Current DB function signature is `payroll_remittance_dashboard(p_organization_id uuid, p_business_id uuid)`.
   - Frontend passes matching named args.
   - Direct live query succeeds.
   - Earlier migration had bad column references, but the current live function returns data.
   - Verdict: **current function is aligned; old console error was from stale deployed/client state or an earlier DB revision**.

7. **Return template source tokens are inconsistent**
   - NSSF/SHIF templates use `employee.statutory_id.nssf` / `employee.statutory_id.shif`.
   - Runtime spreads identifiers as flat keys such as `employee.nssf_number`, `employee.shif_number`, `employee.tax_pin`.
   - `sum_total_amount` and `count_payslips` appear in templates but are not supported by the shared resolver.
   - Verdict: **template rendering can produce blank/incorrect columns even after status gating is fixed**.

## Implementation plan

### Phase 1 — Correct the statutory lifecycle source of truth

- Update the return-template legal-basis rule so all statutory return generation accepts approved payroll results unless a jurisdiction-specific pack explicitly models a legally required post-payment filing event.
- For Kenya pack templates, update at minimum:
  - `NSSF_RET.body.filters.payslip_status` -> include `approved`
  - `SHIF_RET.body.filters.payslip_status` -> include `approved`
  - review `AHL_RET`, `NITA_RET`, `HELB_LR` for the same rule
- Replace UI wording that says cash-basis remittances require paid payslips. Generation requires approved payroll; payment status belongs to remittance settlement.

### Phase 2 — Fix certificate and return data readers to use the same finalized population

- Update `payroll_employee_monthly_breakdown` to include approved payslips and, preferably, join to `payroll_runs.approved_at IS NOT NULL` as the canonical finalization gate.
- Align YTD/certificate provenance so certificate payloads are reconstructed from approved payroll results only.
- Add guards proving P9/P9A monthly grids include approved payslips before payment.

### Phase 3 — Normalize return template source tokens

- Extend the shared return source resolver to support required generic sources:
  - `sum_total_amount`
  - `count_payslips`
  - nested statutory identifier aliases, or migrate templates to flat keys like `employee.nssf_number` and `employee.shif_number`.
- Backfill Kenya return templates so pack metadata matches the runtime contract.
- Add tests that lint all installed return templates against resolver-supported sources.

### Phase 4 — Make regeneration enterprise-safe

- Convert every expected regeneration failure into structured business errors:
  - `RETURN_ALREADY_ACTIVE`
  - `RETURN_STATE_NOT_REGENERABLE`
  - `RETURN_SUPERSEDE_FAILED`
  - `RETURN_STORAGE_WRITE_FAILED`
  - `RETURN_INSERT_FAILED`
- Make the UI and edge function agree on “active run” states and regenerable states.
- Preserve audit history by always linking new runs to `amends_run_id` and writing a transition event.
- Add tests for generated, filed, rejected, pending approval, acknowledged, and submitted regeneration paths.

### Phase 5 — Repair and harden current tenant data/configuration

- Apply a migration to update the live pack templates for NSSF/SHIF and any same-class Kenya templates.
- Re-query April 2026 to verify:
  - run remains approved/posted
  - payslip remains approved
  - NSSF/SHIF eligibility becomes ready
  - Generate button should enable without employee payment
- Verify P10 regeneration after structured error handling is added; if it still fails, the structured error will identify the exact failing branch.

### Phase 6 — Prevent recurrence for new tenants

- Rewrite the architecture tests so new tenants cannot install return templates that exclude `approved` for ordinary statutory schedules.
- Add a pack-health check that flags:
  - templates missing `approved`
  - unknown column sources
  - stale overrides
  - resolver/runtime mismatches
- Add a compliance dashboard signal showing:
  - approved payroll periods with missing/generated/failed returns
  - generated but unsubmitted returns
  - submitted awaiting acknowledgement
  - rejected filings
  - outstanding authority payments
  - regeneration/supersession history

## Expected result after implementation

- Approved payroll immediately unlocks P9, P10, NSSF, SHIF, AHL, NITA and equivalent statutory documents.
- Employee payment remains a separate workflow.
- Authority payment remains a separate remittance settlement workflow.
- Regeneration never returns opaque 500s for business-state issues.
- New tenants cannot inherit the NSSF/SHIF inconsistency because pack metadata and tests will enforce the approved-run lifecycle.