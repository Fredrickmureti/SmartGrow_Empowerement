## Architectural context (verified, not assumed)

**Statutory return pipeline (canonical, verified):**
`generate-statutory-return` → resolves pack template from `localization_pack_return_templates` → gates on `payroll_runs.approved_at` (correct enterprise rule) → pulls `payslips` + `payslip_lines` + `employees` + `employee_statutory_identifiers` → projects one context per employee via **`_shared/returnSourceResolver.ts`** (single writer) → renders CSV / PDF / gov file via `renderGovFile` / `renderReturnPdf` → writes `payroll_return_runs.artifacts[]`.

**Certificate pipeline (canonical, verified):**
`generate-tax-certificate` → resolves pack template from `localization_pack_certificate_templates` (pack-specific → generic fallback) → tenant override coalesce → structural refusal for non-binary templates → **`resolveCertificateYtd()`** (single writer, reads `payroll_employee_ytd_rollup` + provenance) → for `body.kind === "xlsx_binary"` renders via `binaryCertificateRenderer.ts` fetching from `localization_pack_binary_assets.source_url`; otherwise renders via `renderCertificatePdf` (sectioned) → uploads → `payroll_tax_certificates.artifacts[]`.

There are no duplicate loaders. The projection of `employee_statutory_identifiers` onto the context is done **identically** in both generators (spread `identifier_type → value` onto employee). The bugs below are **template/data/asset-fetch defects**, not architectural duplication.

## Root cause per issue

### Issue 1 — NSSF Monthly Return: KRA PIN empty (not a loader bug)

- The Kenya `NSSF_RET` template (verified in DB) declares:
  `{ key: "kra_pin", source: "employee.tax_id" }`
- Actual identifier stored in `employee_statutory_identifiers.identifier_type` is `tax_pin` (verified via query).
- Loader is correct and single-source (`returnSourceResolver.readSource`); the template just addresses the wrong key.
- Certificates work because `generate-tax-certificate` has a compatibility branch:
  `emp.tax_pin = ids.KRA_PIN ?? ids.TAX_PIN ?? ids.TIN` — this branch does **not** exist in returns, and it also assumed uppercase identifier types.
- Also verified: the NSSF template's other cross-country friendly path (`employee.statutory_id.nssf`) resolves correctly (falls through to `nssf_number`) so `NSSF NO` populates — only `KRA PIN` is blank.

**Root cause:** Template addresses a non-existent context key. Canonical statutory-identifier addressing is not documented, so publishers guess.

### Issue 2 — VOLUNTARY column always blank

- NSSF template column: `{ key: "voluntary", source: "sum_rule.nssf_voluntary.employee" }`.
- Verified: no `payroll_statutory_rules` row exists with `rule_code = 'nssf_voluntary'`. The Kenya pack only ships the mandatory tiered `nssf` rule.
- The `sum_rule.<code>` source path is functional (test coverage exists in `return-source-resolver.test.ts`); the bug is that no rule ever produces `payslip_lines.rule_code = 'nssf_voluntary'`, so the sum is always 0 (blank after render).

**Business event research (NSSF Act 2013 + KRA/NSSF returns + Odoo `l10n_ke_hr_payroll` + Workpay/Sage):**
Voluntary NSSF contribution is an **opt-in additional retirement contribution** by the employee (and optionally matched by the employer) on top of the statutory Tier I + Tier II. It is:

- Employee-master-data driven (opt-in flag + optional fixed amount or % of pensionable pay).
- Computed in payroll each period (a real deduction line, GL-posted, remitted with mandatory NSSF).
- Country-specific behaviour that belongs to the **Kenya localization pack**, not generic payroll.
- Rendered on the NSSF Monthly Return in its own dedicated column (matches NSSF byproduct return format).

Conclusion: the current architecture is **almost** correct — a rule exists in the template but is missing from the pack. We must extend the Kenya pack to ship an `nssf_voluntary` statutory rule and expose the opt-in as a canonical pack-registered per-employee input, not hardcode it.

### Issue 3 — P9 / P9A generator 500

Verified data:
- Both templates have `body.kind = "xlsx_binary"` and register `asset_key` values (`certificates/P9.xlsx`, `certificates/P9A.xlsx`).
- Both master workbooks exist in `localization_pack_binary_assets`, but registered under `pack_version_id = b7bc8c4f-...` while the `P9` template row still points at pack_version `4c73c403-...` (verified). The fallback query (by `pack_id + asset_key`) rescues this — not the failure cause.
- `binaryCertificateRenderer.makeUrlAssetFetcher` builds an absolute URL by resolving `/__l5e/assets-v1/...` against `new URL(req.url).origin` — which is the **Supabase Edge Functions origin**, not the Lovable asset CDN. `fetch()` returns non-2xx → generator throws `binaryCertificateRenderer: fetch <url> -> 404` → the per-employee `catch` records it in `errors[]`. When every employee errors, the outer `return jsonResponse(..., 500)` fires, matching the observed behaviour.
- Secondary defects in the same path:
  - `template.body.output: ["xlsx","pdf"]` is authored inside `body`, but `generate-tax-certificate` only reads top-level `template.outputs`. Publishers expect both formats; only xlsx is produced.
  - `payload.employee.tax_pin` uses the same identifier fallback pattern as returns but relies on uppercase (`KRA_PIN`) while the DB stores lowercase (`tax_pin`) — so P9 cell `P6` (employee KRA PIN) would render blank even if the fetch worked.
  - The outer `catch` returns raw exception text; the UI collapses this to "unexpected error".

**Root cause:** the binary-asset URL is not resolvable from the edge runtime, plus identifier-fallback casing drift, plus authoring shape (`body.output`) not honoured by the generator.

## Cross-cutting root cause

There is no **canonical, documented projection contract** for how `employee_statutory_identifiers` rows appear on the template context. Each generator invented casing-tolerant fallbacks in slightly different places (returns: none; certificates: uppercase-only). Templates are then authored against whichever guess the author happened to know. This is what makes the same "KRA PIN missing" bug reappear per surface.

## Fix plan

### A. Canonicalize statutory-identifier projection (shared)

- Extract a single helper `projectEmployeeStatutoryIdentifiers(rows)` in `_shared/employeeStatutoryProjection.ts` used by both `generate-tax-certificate` and `generate-statutory-return`.
- Projection rules (case-agnostic, deterministic):
  - Spread each `identifier_type` in its stored (lowercase) form.
  - Also spread the same value under an uppercased alias so pack templates written against either convention resolve.
  - Populate three well-known aliases when present: `tax_id`, `tax_pin`, `tin` → whichever underlying identifier the pack has registered as the tax identifier (via `pack_token_registry`/`consumes_identifier_type`).
- Remove the ad-hoc `emp.tax_pin = ids.KRA_PIN ?? ids.TAX_PIN ?? ids.TIN` block from `generate-tax-certificate`. Both generators call the shared helper.
- Add architecture test `employee-statutory-projection-single-source.test.ts` locking that no generator reads `employee_statutory_identifiers` outside this helper.

### B. Fix NSSF template (Kenya pack) — via migration

- Update `localization_pack_return_templates` row for `NSSF_RET`:
  - `kra_pin` column → `source: "employee.tax_pin"` (canonical stored identifier).
  - Keep `nssf_no` as `employee.statutory_id.nssf` (already correct).
- No code changes; addresses Issue 1 for existing tenants.

### C. Ship NSSF Voluntary Contribution properly in the Kenya pack

Localization-pack-driven, not hardcoded:

1. **Rule**: add `payroll_statutory_rules` seed row for Kenya pack:
   `rule_code = 'nssf_voluntary'`, `rule_type = 'statutory_deduction'`, `computation_method = 'employee_input'` (reads a per-employee input; no statutory rate), `parameters = { input_key: 'nssf_voluntary_amount', matched_by_employer: false, remit_with: 'nssf' }`.
2. **Employee master data**: register `nssf_voluntary_opt_in` (boolean) and `nssf_voluntary_amount` (currency) as canonical payroll inputs via `payroll_input_types` seeded by the Kenya pack. Rendered on employee → Payroll tab through the existing field-config surface. **No hardcoding in generic UI** — the fields appear only when the Kenya pack is installed.
3. **Computation**: `compute-payroll` already reads generic per-employee inputs into `payslip_lines`; the new rule produces a `payslip_lines` row with `rule_code = 'nssf_voluntary'`. VOLUNTARY column then populates via the existing `sum_rule.*` path — no template change required.
4. **Return filter**: keep `filters.rule_codes: ["nssf", "nssf_voluntary"]` (already present); this ensures the return reconciles against both liabilities.
5. **GL**: rule ships with the same GL mapping as `nssf` (remittance liability account) so posting stays consistent.

### D. Fix P9 / P9A generation end-to-end

1. **Asset fetch**: replace URL-relative fetch. Store master workbooks in the `documents` bucket under `localization-packs/<pack_id>/<asset_key>` at pack install time (migration + one-off backfill), and change `binaryCertificateRenderer`'s fetcher to use `admin.storage.from('documents').download(path)`. This removes the dependency on external URL resolution from inside the edge function.
2. **pack_version_id drift**: repoint the `P9` template row's `pack_version_id` to the version that has the registered asset, or (better) drop the strict `pack_version_id` predicate in the primary query and always match on `pack_id + asset_key` ordered by `created_at desc` — asset lifecycle is versioned by upload time, not template row.
3. **Honour authored outputs**: read `template.body.output[]` as a fallback when `template.outputs` is empty, so P9 emits both xlsx and pdf as the pack author intends. Add a PDF branch for `xlsx_binary` templates that converts the rendered xlsx via the existing PDF path, or (simpler) skip PDF until a dedicated xlsx→pdf renderer lands — but at minimum stop silently dropping the authored output list.
4. **Identifier projection**: use the shared helper from (A), so `payload.employee.tax_pin` populates correctly for both P9 (cell `P6`) and P9A.
5. **Error surface**: outer `catch` in `generate-tax-certificate` returns structured `businessError(500, "CERT_GENERATE_FAILED", …, details: { detail: e.message })` so the UI can show the real reason instead of "unexpected error". Also ensure per-employee errors surface with `code` + first-failure `message` when `created` is empty.

### E. Regression guards

- Arch test: templates in `localization_pack_return_templates` may only address `employee.<key>` values that resolve against the canonical projection (fail if a template references `employee.tax_id` when only `tax_pin` is registered).
- Arch test: every `xlsx_binary` certificate template must have a corresponding `localization_pack_binary_assets` row (any version, any storage location) at install time — enforced in `install-localization-pack` and in a static test.
- Pack lint (`lint-localization-pack`): warn on `sum_rule.<code>.*` sources when `<code>` is not among the pack's known `payroll_statutory_rules.rule_code` values.
- Unit test on the new asset fetcher covering storage-backed download.

### F. Deploy & verify

1. Apply migrations (NSSF template fix, `nssf_voluntary` rule seed, `payroll_input_types` seed, binary-asset storage backfill, P9 pack_version repoint).
2. Deploy `generate-tax-certificate`, `generate-statutory-return`, `install-localization-pack`, `binaryCertificateRenderer` consumers.
3. Manual E2E (via Playwright against localhost preview, restoring the managed Supabase session):
   - Regenerate NSSF_RET for an approved period → confirm KRA PIN column populated for every employee.
   - Set `nssf_voluntary_amount = 500` on one employee → run payroll → regenerate NSSF_RET → confirm VOLUNTARY = 500 for that employee only.
   - Generate P9 and P9A for an employee with YTD data → confirm 200 + downloadable xlsx + KRA PIN in cell P6.
   - Regenerate `CERT_OF_SERVICE` and `ANNUAL_EARNINGS_STATEMENT` → confirm no regression.

## Deliverables checklist

- Single canonical statutory-identifier projection (shared helper + arch test).
- NSSF_RET template fix migration.
- Kenya pack extension: `nssf_voluntary` rule + `payroll_input_types` seeds + GL mapping.
- Storage-backed binary asset fetch + backfill migration.
- Generator fix for authored `body.output[]` fallback.
- Structured error envelope on the outer catch.
- Regression tests (arch + lint + unit).
- E2E verification of every impacted surface, plus non-regression check on already-working certificates.
