# Payroll Reporting, Certificates & Returns — Enterprise Alignment

## Status snapshot (2026-07-12)

**Turn 2 executed** the certificate half of the pack-declared exports
architecture: `payroll_tax_certificates.artifacts jsonb`, per-employee
dispatch loop over `template.outputs`, lifecycle gate wired into both
generators, shared `OutputsCard` publisher control + `usePackFormatRegistry`
hook, and KE pack metadata backfill. Both edge functions redeployed.
`pack-declared-exports.test.ts` and new `lifecycle-gate-callsites.test.ts`
are green.

### ✅ Shipped this turn

- **Migration** `20260711234728` — `payroll_tax_certificates.artifacts jsonb NOT NULL DEFAULT '[]'` + one-shot backfill from `pdf_path` / `xlsx_path`.
- **Generator** `generate-tax-certificate/index.ts` — hardcoded `body.kind==='xlsx_binary'` branch replaced by loop over `template.outputs` (default derived from `body.kind`); lazy renderers for PDF and xlsx_binary; canonical `artifactsList[]` written to `insert`; sharpened error codes (`MASTER_WORKBOOK_MISSING`, `OUTPUT_INCOMPATIBLE`, `NO_ARTIFACTS_PRODUCED`, `CERT_OUTPUT_UNSUPPORTED`); `requireApprovedRunsForYear` gate wired.
- **Generator** `generate-statutory-return/index.ts` — `requireClosedPeriod` wired after template resolution; gate is advisory when the tenant hasn't operationalised `payroll_periods` (module now returns OK when no row matches) so run-driven customers aren't broken.
- **Endpoint** `download-tax-certificate` — accepts `artifact_path` alongside `certificate_id` / `pdf_path`; resolves parent row for permission checks; supports optional `filename` override.
- **Hook** `useTaxCertificates.ts` — `TaxCertificate.artifacts?[]` typed; `downloadTaxCertificate()` accepts `{artifact_path, filename?}` in addition to legacy shapes.
- **UI** `src/pages/hr/payroll/TaxCertificates.tsx` — one download button per artifact with legacy fallback that mirrors `pdf_path` / `xlsx_path` into artifact shape.
- **Publisher** shared `OutputsCard.tsx` mounted from `CertificateTemplateEditor.tsx` and `ReturnTemplateEditor.tsx`; format list read from `format_registry` via `usePackFormatRegistry.ts`. `PackEntityTabs.tsx` persists `outputs` through metadata whitelist.
- **KE pack backfill** — P9 / P9A → `[{xlsx_binary,primary}]`; ANNUAL_EARNINGS_STATEMENT / CERT_OF_SERVICE → `[{pdf,primary}]`; NSSF_RET → `[{gov_xlsx,primary},{csv,audit}]`. `GH_PAYE_EMPLOYEE_ANNUAL` skipped — body still missing `data_source`; content fix pending.
- **Test** `src/test/payroll/lifecycle-gate-callsites.test.ts` — locks both lifecycle imports + call sites.

### 🚧 Remaining

- **Content fix:** publish a fresh `GH_PAYE_EMPLOYEE_ANNUAL` body with `data_source` + section contract before backfilling its `outputs`.
- **Runtime verification:** rerun P9 / P9A / AES / NSSF_RET against a KE tenant with an approved FY 2025/2026 run; confirm every declared artifact opens through the signed URL. Logs currently show only boots — no one has exercised the new path yet.
- **Part F legacy cleanup:** drop `csv_path` / `pdf_path` / `gov_file_path` on `payroll_return_runs` and the `output` scalar on `localization_pack_return_templates` once every reader has migrated to `artifacts`. Certificate scalars stay one more release.
- **Publisher round-trip test:** load a template with `outputs`, edit via `ReturnTemplateEditor`, save, reload, assert identity.

---

## Turn 1 — verification & plan

### Verification of prior agent's claims (Turn 1)

| Claim | Verdict |
|---|---|
| Migration `20260711232041` adds `format_registry`, `outputs jsonb`, `payroll_return_runs.artifacts`, validation trigger, backfill | ✅ Real. Structure, GRANTs, RLS, backfill and trigger all correct. |
| `generate-statutory-return` emits canonical `artifacts[]` | ✅ Real. `pushArtifact()` fires on CSV, PDF and gov-file branches; `.insert` and both `.select` projections include `artifacts`. |
| `useStatutoryReturns` normalises `artifacts` | ✅ Real. Types + `normalizeReturnArtifactPath` mapping present. |
| `ReturnsTab` renders one download per artifact w/ legacy fallback | ✅ Real. Loop + legacy fallback, no hardcoded CSV/PDF button. |
| `_shared/payrollLifecycleGate.ts` shipped | ✅ File exists, module is production-shape — **but NOT imported by either generator yet.** |
| Arch test `pack-declared-exports.test.ts` green | ✅ File exists with the four assertions. |
| P9/P9A pack templates + binary assets present | ✅ Both rows exist; `body.kind='xlsx_binary'` and `localization_pack_binary_assets` rows registered (P9 by pack_id, P9A by pack_version_id). |
| Publisher editors updated for `outputs` | ❌ Editors exist but do not read/write the new `outputs jsonb`. |
| `payroll_tax_certificates.artifacts` column | ❌ Not created. Certs still on `pdf_path` / `xlsx_path` scalars. |
| KE pack templates carry `outputs` metadata | ❌ All rows have `outputs = NULL`. |

Prior work is genuine and can be built on — no rollback needed.

## Root-cause hypothesis for P9 / P9A / AES failures

- **P9 / P9A** (`body.kind = 'xlsx_binary'`) skip the structural refusal, so the 422s users see must come from the xlsx branch: either the `pack_version_id`-scoped asset lookup missing (P9 has one asset row but only under `pack_id`, not the current `pack_version_id`) or the binary renderer throwing. Runtime edge-function log inspection is required before patching — no blind fix.
- **Annual Earnings Statement** has full sections but `pack_id = NULL` (unpacked template) and no `outputs`, so it falls through to `renderCertificatePdf`. Likely failure is inside that renderer against the current AES body, or a downstream token/monthly-breakdown RPC call. Confirm via logs before touching code.
- **Cert of Service works** because it has the section contract *and* the renderer path exercised by every prior release.

Fix strategy is architectural (loop `template.outputs`, dispatch per format), not per-template patch.

## Plan

### Step 1 — Diagnose the live P9/P9A/AES 500/422 (read-only)

- Pull recent `generate-tax-certificate` edge-function logs (`supabase--edge_function_logs`) filtering by `error`, `TEMPLATE_STRUCTURAL_INVALID`, `master workbook`, `renderCertificatePdf`, `xlsx`.
- Query `payroll_diagnostics` for `code IN ('TEMPLATE_STRUCTURAL_INVALID','TOKEN_UNRESOLVED')` in the last 24h.
- Record the actual failure signature for each of P9, P9A, AES. Only *then* select the fix branch (asset lookup vs. renderer vs. template body).

### Step 2 — Certificates: artifacts column + loop `outputs`

Migration (single file):

- `ALTER TABLE payroll_tax_certificates ADD COLUMN artifacts jsonb NOT NULL DEFAULT '[]'`
- Backfill from `pdf_path` / `xlsx_path` mirroring the returns backfill.
- Comment marks `pdf_path` / `xlsx_path` as deprecated read-mirrors.

`generate-tax-certificate/index.ts` refactor:

- Resolve `outputs` = `template.outputs ?? [{format: kind==='xlsx_binary' ? 'xlsx_binary' : 'pdf', role:'primary'}]`.
- Loop `outputs`, dispatch each entry to `renderCertificatePdf` or `renderBinaryCertificateXlsx`; upload; append to a local `artifacts[]` with `{format,path,mime,ext,size,role,generated_at}`.
- Insert `artifacts` alongside legacy `pdf_path`/`xlsx_path` (both populated for one release).
- Fix the P9 asset lookup to also match by `pack_id + asset_key` fallback (already partially there — extend to log which branch matched).

Frontend:

- `src/hooks/payroll/useTaxCertificates.ts`: add `artifacts` to the `TaxCertificate` type; normalise like returns.
- Tax certificates surface (inside `PayrollWorkspace` — no dedicated `TaxCertificatesTab.tsx`; consumer to be located during Step 1): render one download button per artifact with a legacy fallback identical to `ReturnsTab`.
- `download-tax-certificate` accepts an `artifact_path` alternative to the `format` scalar so multi-artifact rows can address any file.

### Step 3 — Wire `payrollLifecycleGate` into both generators

- `generate-tax-certificate`: call `requireApprovedRunsForYear` right after body validation (replaces the ad-hoc count block currently at lines 320-347). Map failure to `businessError(422, code, message, recovery, details)`.
- `generate-statutory-return`: call `requireClosedPeriod` after template resolution, before writers run.
- New test `src/test/payroll/lifecycle-gate-callsites.test.ts` greps both files for the imports + call sites so the gate cannot be silently removed.

### Step 4 — Publisher editors author `outputs`

- New `src/hooks/localization/usePackFormatRegistry.ts` — public-read query against `format_registry`, cached.
- `CertificateTemplateEditor.tsx` and `ReturnTemplateEditor.tsx`: add an "Outputs" section (multi-select of formats + per-entry `label` / `filename` / `role`). Persist to `outputs jsonb`. Trigger already blocks unknown formats — editor just projects the whitelist.
- New test locks in that the editor writes the `outputs` field and that the round-trip preserves it.

### Step 5 — KE pack backfill (data migration via `supabase--insert`)

- `NSSF_RET` → `[{format:'gov_xlsx',role:'primary'},{format:'csv',role:'audit'}]`
- `P9`, `P9A` → `[{format:'xlsx_binary',role:'primary'}]`
- `ANNUAL_EARNINGS_STATEMENT`, `CERT_OF_SERVICE`, `GH_PAYE_EMPLOYEE_ANNUAL` → `[{format:'pdf',role:'primary'}]`
- No pack version bump — metadata only.

### Step 6 — Runtime verification

For a chosen KE tenant with an approved FY 2025/2026 run:

- Regenerate P9, P9A, AES and Cert of Service via the actual edge function. Assert the response payload lists the expected artifacts and that signed downloads open in the browser.
- Regenerate NSSF Monthly return; assert `run.artifacts` contains both `gov_xlsx` (primary) and `csv` (audit).
- Log evidence into the plan's status snapshot for the hand-off.

### Step 7 — Legacy cleanup (Part F, gated on verification)

- Grep for `csv_path`, `pdf_path`, `gov_file_path`, `xlsx_path` readers. Migrate any remaining reader (`ReturnRunHistoryDrawer`, `record-return-filing`, download edge functions) onto `artifacts`.
- Migration drops `csv_path` / `pdf_path` / `gov_file_path` from `payroll_return_runs` and the `output` scalar on `localization_pack_return_templates`. `pdf_path` / `xlsx_path` on `payroll_tax_certificates` stay for one more release because tenant history depends on them.

### Step 8 — Edge function deploys & tests

- Deploy `generate-tax-certificate` and `generate-statutory-return`.
- Run vitest (`pack-declared-exports.test.ts`, new lifecycle-gate test, new publisher editor test).
- Run Deno tests for both edge functions.

## Technical details

- Every new artifact row obeys the shape `{format,path,mime,ext,size?,sha256?,role,generated_at}` — enforced structurally by the trigger `assert_outputs_formats_registered` on templates and by TypeScript in the hooks.
- Renderer contract: dispatch is `writer` column from `format_registry`, not a hardcoded switch — adding a new writer means one INSERT into `format_registry` plus one branch in `_shared/pdf/…` / `_shared/govFileWriter.ts`.
- Enterprise parity references: Odoo `report.report_action.report_type`, SAP `HR_FORMS`, Workday "Output Profile", Oracle BI Publisher output types. All four decouple template from format list — this plan lands the same decoupling.
