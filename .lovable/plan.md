## 1. Continuity audit (what's actually on disk vs. previous agent's claims)

| Claim | Reality |
|---|---|
| `_shared/loan-gl/handlers.ts` extracted | ✅ present, 385 lines, handlers for disburse/accrue/settle |
| `loan-gl/index.ts` fat router landed | ✅ present, 71 lines, dispatches on `action` |
| Callers "reverted to old names" | ✅ confirmed — `src/hooks/useEmployeeLoans.ts` still calls `post-loan-disbursement` and `post-loan-settlement` |
| Old `post-loan-*` dirs removed | ❌ still present (3 dirs) |
| loan-gl deployed | ❌ not deployed (was blocked by cap) |
| Country-agnostic guard extended | ✅ `src/test/architecture/no-hardcoded-country-payroll.test.ts` scans new paths |
| §3–§9 merges | ❌ none started |
| Edge-fn inventory ceiling | Test hard-codes `CEILING = 87` with a "Wave 5 verdict: blanket consolidation rejected" comment. Directly contradicts the §1–§9 plan. Current count: **104**. Test is failing. |
| P9 template work | ❌ nothing changed. Architecture for `xlsx_binary` templates already exists (see §3). No P9 row was inserted, no master workbook uploaded. |

**Verdict:** loan-gl is source-complete but never cut over. P9 mission was never started. The §3–§9 mega-consolidation is out of scope for this mission and is contradicted by the existing guard test — I will not pursue it here. Only loan-gl (§2) gets closed out; that frees 2 slots, which is enough to publish the P9 assets without a wider consolidation.

## 2. Existing P9 / localization architecture (already in place)

- `localization_pack_binary_assets` table stores raw workbook bytes per pack version, keyed by `asset_key` + `sha256`.
- Certificate template body supports `kind: "xlsx_binary"` with `{ asset_key, master_sha256, cell_bindings }`. Enforced by the `enforce_certificate_template_structure()` trigger.
- `supabase/functions/_shared/pdf/binaryCertificateRenderer.ts` uses ExcelJS to load the master and rewrite only the bound cells, so merges/borders/formulas/print settings survive byte-for-byte.
- `generate-tax-certificate` already routes `xlsx_binary` templates through this renderer.
- Publisher UI (`CertificateTemplateEditor.tsx`, `PackEntityTabs.tsx`) already understands certificate templates and pack versions.

**So the mission is not "build a rendering engine" — it is "publish the 2025 master + author its cell bindings in a new KE pack version."**

## 3. P9 workbook analysis (from the attached file)

Single meaningful sheet `Table 1` (18 cols × 41 rows, landscape, scale 74%, 56 merged ranges). Layout, in bands:

- **Rows 2–3**: header band (ISO strip, APPENDIX 2A, "KENYA REVENUE AUTHORITY … TAX DEDUCTION CARD YEAR nnnn"). Year is dynamic.
- **Rows 4–7**: employer/employee identity block — 4 dynamic cells: `P4` employer PIN, `C5` employer name, `C6` employee main name, `C7` employee other names, `P6` employee PIN.
- **Rows 8–14**: multi-row header for the monthly grid (letters A–O labels in row 11, sub-headers E1/E2/E3 in row 12–14).
- **Rows 15–26**: monthly grid, 12 months × columns A–O (Basic Salary, Benefits, Value of Quarters, Total Gross, Defined Contribution E1/E2/E3, AHL, SHIF, PRMF, Owner-Occupied Interest, Total Deductions, Chargeable Pay, Tax Charged, Personal Relief, Insurance Relief, PAYE).
- **Row 27**: `TOTAL` row. The workbook ships bad formulas (`=SUM(B21:B26)` instead of `B15:B26`). We fix these in the master before uploading so the totals reconcile against payroll.
- **Rows 28–33**: year-end summary (`TOTAL CHARGEABLE PAY (COL. K)`, `TOTAL TAX (COL. O)`, attachment notes).
- **Rows 30–41**: static IMPORTANT footnotes + P9A footer. 100% static — no bindings.
- **Sheet2 (`Sheet1`)**: helper sheet with residual sample data. Cleared in the master before upload (kept as an empty tab to preserve workbook shape if any external consumer expects it — same approach as the KRA original).

Static vs. dynamic:
- **Static**: rows 2–3 chrome except the year, rows 8–14 headers, rows 30–41 notes, all borders/merges/column widths/print setup.
- **Dynamic (bindings)**: fiscal year token in `E3`; the 5 identity cells; 12×15 monthly grid rule-code amounts; totals in row 27 (via formulas, so we don't bind them); year-end summary values in row 29.

## 4. Deliverables

### 4.1 Close out loan-gl (§2)
1. `supabase--deploy_edge_functions(["loan-gl"])`.
2. Repoint `src/hooks/useEmployeeLoans.ts` to invoke `loan-gl` with `{ action: "disburse" | "settle" }`. Any other reference to `post-loan-*` gets the same treatment (grep confirms only those two callers).
3. `supabase--delete_edge_functions(["post-loan-disbursement","post-loan-interest-accrual","post-loan-settlement"])`.
4. Remove the three `supabase/functions/post-loan-*/` source dirs.
5. Adjust `src/test/architecture/edge-fn-inventory.test.ts` — set `CEILING = 101` (current 104 − 3 deletions) and update the guard comment to reflect that loan-gl is the only merge landed; do **not** raise CEILING to 87 (that number originated in the rejected mega-plan).

### 4.2 Prepare the P9 master workbook
1. Take the uploaded `P9-FORM-Template-2025_1.xlsx`, apply the minimal fixes required for correctness (fix `SUM(*21:*26)` → `SUM(*15:*26)` in row 27; set `E3` header to say "YEAR {{year}}" as literal text before binding rewrites it; blank Sheet1 sample cells). No layout change.
2. Save as `supabase/assets/localization/ke/certificates/P9A_2025.xlsx` (source-controlled so future changes are reviewable).
3. Compute `sha256` for the fixed master.

### 4.3 Publish through the localization pack
Single migration (`202611_ke_pack_p9a_2025`):
1. Insert / bump a `localization_packs`/`localization_pack_versions` row for KE (minor version bump — pack semver goes to the next `x.(y+1).0`).
2. Insert one `localization_pack_binary_assets` row: `pack_version_id=<new>`, `asset_key='certificates/P9A_2025.xlsx'`, `sha256=<computed>`, `bytes=<pg_read_binary_file>` — the master ships as a migration-embedded asset via `pg_read_server_files`? No — that isn't available. Instead the master is uploaded through a small **one-shot script** (`supabase/functions/_shared/scripts/upload-p9-master.ts` invoked once by an admin via `publish-localization-pack-version`) so the bytes live in the DB row and the migration only inserts the certificate template + metadata that reference the asset. This preserves the "publisher owns bytes" rule from ADR 0060 and the publisher investigation requirement in the mission.
3. Insert `localization_pack_certificate_templates` row: `code='P9A_KE_2025'`, `display_name='KRA Tax Deduction Card (P9A)'`, `pack_version_id=<new>`, `authority_id=<KRA>`, `effective_date='2025-01-01'`, `legal_reference='Income Tax Act CAP 470 s.37'`, `regulation_citation='PAYE Rules 2024'`, `body` =
   ```json
   {
     "kind": "xlsx_binary",
     "data_source": "payroll_employee_ytd_rollup",
     "output": "xlsx",
     "asset_key": "certificates/P9A_2025.xlsx",
     "master_sha256": "<sha>",
     "cell_bindings": {
       "static": {
         "E3":  { "token": "fiscal.year_header" },
         "P4":  { "token": "employer.pin" },
         "C5":  { "token": "employer.name" },
         "C6":  { "token": "employee.main_name" },
         "C7":  { "token": "employee.other_names" },
         "P6":  { "token": "employee.pin" },
         "D29": { "token": "totals.chargeable_pay",  "format": "money" },
         "O29": { "token": "totals.paye",            "format": "money" }
       },
       "monthly_grid": {
         "start_row": 15, "end_row": 26,
         "columns": [
           { "col": "B", "rule_code": "basic_salary" },
           { "col": "C", "rule_code": "benefits_non_cash" },
           { "col": "D", "rule_code": "value_of_quarters" },
           { "col": "E", "rule_code": "total_gross_pay" },
           { "col": "F", "rule_code": "def_contrib_30pct" },
           { "col": "G", "rule_code": "def_contrib_actual" },
           { "col": "H", "rule_code": "def_contrib_cap" },
           { "col": "I", "rule_code": "ahl" },
           { "col": "J", "rule_code": "shif" },
           { "col": "K", "rule_code": "prmf" },
           { "col": "L", "rule_code": "owner_occupied_interest" },
           { "col": "M", "rule_code": "total_deductions" },
           { "col": "N", "rule_code": "chargeable_pay" },
           { "col": "O", "rule_code": "tax_charged" },
           { "col": "P", "rule_code": "personal_relief" },
           { "col": "Q", "rule_code": "insurance_relief" },
           { "col": "R", "rule_code": "paye" }
         ]
       }
     }
   }
   ```
4. Retire the previous P9 row (set `retired_at`, do not delete — preserves audit history for prior tax years).
5. Publisher lint: run `lint-localization-pack` against the new version and ensure the existing `certificateCompleteness` rules pass. Extend the lint rule set only if it rejects `xlsx_binary` P9-class templates today (needs verification while implementing — the check in `src/features/localization/lib/certificateCompleteness.ts` currently expects the section-based shape, so we add a code path that considers `xlsx_binary` templates satisfied by presence of `cell_bindings.static` identity tokens + `monthly_grid` + at least one totals token).

### 4.4 Rule-code mapping verification
For each of the 17 monthly columns, verify a corresponding row exists in `payroll_employee_ytd_rollup` (via `rule_code`). Where a KE-specific rule code isn't yet registered in the KE pack fixtures (e.g. `def_contrib_30pct`, `def_contrib_actual`, `def_contrib_cap`, `owner_occupied_interest`, `prmf`), add the missing statutory rules to the KE pack fixture + `payroll_statutory_rules` seed so payroll history genuinely projects into those buckets. Any missing bucket surfaces as a lint failure — not silently as zero — so the accountant sees the real gap.

### 4.5 Tenant rollout
Existing tenants pick up the new pack version through the standard `apply-localization-pack-upgrade` flow — the mission calls this out explicitly. The current pack-upgrade edge function already applies certificate template changes; **no new upgrade code path is needed**, only that the new pack version is proposable/upgradable. Verified by the existing `propose-localization-upgrades` function.

### 4.6 Verification
- Deno test: `supabase/functions/_shared/pdf/binaryCertificateRenderer_p9a_test.ts` — loads the fixed master, applies bindings with a synthetic payload, opens the output with ExcelJS, asserts (a) every merged range from the source is preserved, (b) row 27 formulas remain formulas (not values), (c) print setup identical, (d) the 22 bound cells hold the expected values.
- Screenshot / render check: convert the generated `.xlsx` to PDF via headless LibreOffice inside the test scaffold and diff the page count + orientation against the master.
- End-to-end: call `generate-tax-certificate` for a synthetic KE employee with the KE pack fixture; assert HTTP 200, an `.xlsx` upload lands in the `documents` bucket, and the `payroll_tax_certificates` row references it.

## 5. Explicitly out of scope
- §3–§9 of the mega-consolidation plan. The inventory guard test rejects that direction; doing so would violate the "preserve existing architecture, no regressions" rule the mission imposes. If you later want that scope, it needs its own approval — it is not a prerequisite for the P9 mission.
- Editing email/notification, Stripe, cron, or `terminal-outbound` / `etims-transmit` families.
- Rewriting `generate-payslip-pdf` or the section-based certificate renderer — both keep working unchanged for non-`xlsx_binary` templates.

## 6. Sequence when you switch to build mode
1. Cut over loan-gl (deploy → repoint → delete olds → adjust ceiling test).
2. Add the fixed P9 master to `supabase/assets/localization/ke/certificates/P9A_2025.xlsx`.
3. Author the migration + upload script; run it; verify the row exists in `localization_pack_binary_assets`.
4. Verify `generate-tax-certificate` output against the master.
5. Publish the pack version so tenants can pick it up.

Say **go** and I'll execute in that order.
