## Findings

**The tax-certificate pipeline is architecturally correct. The Kenya localization pack ships a broken P9A template.** The observed symptoms all trace to that single class of defect, amplified by an engine gap that lets bad templates be persisted.

### Certificate lifecycle (as-built, verified)

```
payslip_lines (frozen at run.approved_at)
   ↓
payroll_employee_ytd_rollup  (canonical YTD projection — SQL RPC)
payroll_employee_monthly_breakdown  (canonical monthly projection — SQL RPC)
   ↓
resolveCertificateYtd  (single reader — ADR-0060, arch-test locked)
   ↓
generate-tax-certificate  (template resolve → structural validate → payload assemble)
   ↓
certificate-engine v3 compile (HTML, CSS Paged Media — “preview === output”)
   ↓
payroll_tax_certificates row (payload snapshot + artifacts[] + provenance)
   ↓
lifecycle: issued / superseded / stale (regenerate flow)
```

The renderer never computes; formulas live in the pack template's `derived_columns`. That layering is right. The problem is upstream: the pack shipped a template where the formulas are missing.

### Root cause

`localization_pack_certificate_templates.body.document[6]` for `P9A` (grid node bound to `p9.months`) declares 18 columns. Six of them — `col_d` (Total Gross Pay = A+B+C), `col_e1` (defined pension contribution), `col_e3` (actual pension contribution), `col_j` (chargeable pay), `col_k` (chargeable pay after mortgage relief), `col_l` (tax charged) — carry **no `source_key`, no membership in `derived_columns`**. These columns are statutorily computed, not read from a rule_code.

The engine's structural validator (`validateCanonicalSourceNode`) correctly refuses this with **HTTP 422 `TEMPLATE_STRUCTURAL_INVALID` / `GRID_COLUMN_UNBOUND`**. That is exactly the 422 the user sees on regenerate. Any prior "successful" issuance either predates this validator or was skipped via the idempotency short-circuit — the resulting payload contained `p9.months` rows with zeros in every unbound column, which is the "generates but empty" symptom.

The DB-level guard `assert_certificate_template_body_valid` does not enforce the column-binding contract, so the bad body was accepted at pack-publish time. That is the systemic gap.

### Architectural verdict

- Pipeline design (canonical resolver → declarative pack → generic renderer) is sound and matches how SAP HCM / Workday / Oracle HCM separate statutory schema from computation.
- Two concrete defects to fix:
  1. **Kenya pack P9A template body is incomplete** — missing `derived_columns` block for the computed KRA columns.
  2. **Engine allows structurally-invalid templates to be persisted** — runtime refuses them, but by then they have already shipped and every generation attempt 422s.

## Remediation plan

### 1. Republish P9A with complete `derived_columns` (migration)

Update the pack row in `localization_pack_certificate_templates` (code=`P9A`, pack_id=Kenya) via migration to attach a `derived_columns` array to the grid node:

- `col_d = col_a + col_b + col_c` (Total Gross Pay)
- `col_e1 = min(0.30 * col_a, 30000)` (defined pension contribution cap, KRA 2024 rules — pack-owned constant)
- `col_e3 = col_e1` (actual = defined when no separate contribution source)
- `col_j = col_d − col_e1 − col_e2 − col_e3 − col_f − col_g − col_h` (chargeable pay before mortgage)
- `col_k = col_j − col_i` (chargeable pay)
- `col_l = paye_gross_from_bands(col_k)` — expressed via the pack's supported derived arithmetic; if bands are not expressible in current derived-column grammar, bind `col_l` to a new canonical rule_code `paye_gross` that the payroll engine already produces, and keep the derived expression only for column arithmetic

The Kenya pack owns these formulas — no country logic enters the generator.

### 2. Extend DB validator to enforce column-binding contract

New assertion added to `assert_certificate_template_body_valid` (or a new trigger): for every `grid`/`matrix` node, every non-month data column must have `source_key` OR appear as a key in `derived_columns`. Mirrors the runtime check in `validateCanonicalSourceNode`, so a broken template cannot be inserted or updated in the first place. Backfill audit: run the same check against all existing pack rows and emit `payroll_diagnostics` for any that fail (surfaces GH_PAYE / ANNUAL_EARNINGS / CERT_OF_SERVICE regressions in one pass).

### 3. Refuse silent empty issuance

Add an "empty payroll year" guard in `generate-tax-certificate` after payload assembly: if `rows.length === 0` AND every monthly grid row sums to zero, refuse with `EMPTY_PAYROLL_YEAR` (recovery: "run and approve at least one payroll for FY <year> before issuing a certificate"). Removes the ambiguous "issued but blank" outcome for the certificates that are not `CERT_OF_SERVICE`.

### 4. Regenerate/supersede semantics

Confirmed correct: on `regenerate=true` the prior `issued` row is flipped to `superseded` and a new row is inserted, both retained (audit trail). Once (1) lands, the 422 disappears; no behavioural change needed here.

### 5. Coverage tests (block regressions class-wide)

Add architecture tests under `src/test/architecture/`:
- **`certificate-templates-canonical-binding.test.ts`** — loads every row from `localization_pack_certificate_templates`, walks each grid/matrix, asserts every data column is bound. Fails CI when any pack ships an unbound column.
- **`certificate-empty-year-refused.test.ts`** — asserts the `EMPTY_PAYROLL_YEAR` branch exists in the generator.

### 6. Verification

- Deploy the updated P9A pack + validator migration.
- `curl` `generate-tax-certificate` for a known employee with approved payroll → expect populated grid.
- `curl` for an employee with no payroll → expect `EMPTY_PAYROLL_YEAR` (not empty PDF).
- Regenerate an already-issued cert → expect prior row superseded, new row issued, no 422.
- Attempt to `UPDATE` a pack template body to strip `source_key` from a column → expect DB trigger refusal.

### Out of scope (deliberate, keeps engine layering intact)

- No changes to the renderer (`certificate-engine v3 compile`) — computation must not migrate into HTML.
- No changes to `resolveCertificateYtd` — it is already the single reader.
- No new per-country branches in the generator.

### Technical notes

- Files: `supabase/functions/generate-tax-certificate/index.ts`, `supabase/functions/_shared/certificateSourceResolver.ts`, `supabase/functions/_shared/certificateMatrix.ts`.
- New migration touches `localization_pack_certificate_templates` (P9A body update) and `assert_certificate_template_body_valid` (or adds a companion trigger). No new tables.
- All new refusals go through `businessError()` so the UI keeps rendering the structured `{code, message, recovery}` envelope.
