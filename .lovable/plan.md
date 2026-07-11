# Payroll Reporting, Certificates & Returns — Enterprise Alignment

## Status snapshot (2026-07-11)

Prior turn shipped: renderer normalisation for `xlsx_binary` (array + object
`cell_bindings`, `header.title_with_year`), `employer.legal_name` /
`employee.other_names` aliases in the certificate context, a valid
`Annual Earnings Statement` body (`data_source`, employer/signature sections,
`effective_date`), and a first pass at the artifact-driven Returns download
button.

This turn shipped **PART A (backend + hook + UI)** and **PART C (shared
lifecycle gate module)**. Publisher UI, cert generator refactor to loop
`outputs`, and full deprecation of the legacy path columns remain.

---

## ✅ Done this turn

### A1 — Data model (migration `20260711-232057`)
- New `public.format_registry` table, seeded with `csv`, `pdf`, `gov_csv`,
  `gov_xlsx`, `gov_xml`, `xlsx_binary`, `xml`. Public-read RLS. Referenced by
  every pack-declared output going forward.
- `localization_pack_return_templates.outputs jsonb` (nullable) — pack declares
  the exact set of files to produce.
- `localization_pack_certificate_templates.outputs jsonb` (nullable) — same
  contract for certificates.
- `payroll_return_runs.artifacts jsonb NOT NULL DEFAULT '[]'::jsonb` — canonical
  per-run artifact list, back-filled from `csv_path` / `pdf_path` /
  `gov_file_path` for every historical row via a one-shot `UPDATE`.
- Trigger `assert_outputs_formats_registered()` on both template tables —
  rejects any `outputs[].format` that is not in `format_registry`. Errors are
  actionable (`23514` with format name in the message).

### A2 — Generator (`supabase/functions/generate-statutory-return/index.ts`)
- New in-scope `Artifact` type + `pushArtifact()` closure.
- Every writer branch (CSV / PDF / gov file) now appends to the local
  `artifacts` array with `{format, path, mime, ext, size, role, generated_at}`.
- `.insert(...)` writes `artifacts` alongside the legacy path columns; both
  active `.select(...)` projections include `artifacts` so the hook receives it.
- Legacy scalar columns are still populated verbatim for one release —
  planned deprecation flagged in PART F below.
- **Deployed** to project `jkszmrroyjfdwokbkzis` this turn.

### A3 — Hook (`src/hooks/payroll/useStatutoryReturns.ts`)
- `ReturnRun.artifacts` type added (union of the format string + role
  literal). Doc comment references this plan.
- `useReturnRuns` maps `run.artifacts` through `normalizeReturnArtifactPath`
  so every artifact behaves identically for `downloadReturnArtifact()`.

### A3 — UI (`src/components/payroll/ReturnsTab.tsx`)
- Downloads column now renders one button per artifact via a single loop,
  labels driven by `format` (Excel / Gov CSV / Gov XML / PDF …), icon
  chosen by format.
- Empty-state chip when a run genuinely has no downloads (rare — usually
  means the generator upload failed before writing the row).
- Legacy `r.csv_path` / `r.pdf_path` / `r.gov_file_path` are projected into
  the same artifact shape as a fallback so pre-migration history still
  downloads. No hardcoded "CSV" or "PDF" button remains.

### B — P9 / P9A binding contract (verified from prior turn)
- Renderer accepts both the object (`static: {...}`) and array
  (`[{cell,token,format}]`) shapes for `cell_bindings`, and resolves the
  derived `header.title_with_year` token. Confirmed in code, no changes
  needed this turn.

### C — Shared lifecycle gate
- New module `supabase/functions/_shared/payrollLifecycleGate.ts` with
  `requireApprovedRunsForYear(fy)` and `requireClosedPeriod(period)`.
- Returns a structured `{ok, code, message, recovery, details}` result so
  callers map it straight onto `businessError()`. Aligned with SAP HCM
  (`PC00_M99_CIPE`), Workday ("Complete"), Odoo (`state='done'`),
  Oracle HCM (`Verified`/`Prepayments`).
- **Not yet wired** into `generate-tax-certificate` or
  `generate-statutory-return`. Wiring is the next follow-up (see PART C
  below); the module ships first so both functions can adopt it in a
  single reviewable diff.

### D — Architecture test
- `src/test/architecture/pack-declared-exports.test.ts` (4 tests, all
  green) locks in:
  1. Generator pushes every writer branch into `artifacts` and includes
     it on `.insert(...)` and both `.select(...)`.
  2. Hook types `artifacts` and normalises paths.
  3. UI renders artifact-driven buttons, no legacy hardcoded branch.
  4. Every writer the migration registers has a matching writer symbol
     in `_shared/govFileWriter.ts` / `binaryCertificateRenderer.ts`.

---

## 🚧 Remaining work — hand-off checklist for the next agent

### PART A follow-through
- **A2 (certificates):** `generate-tax-certificate` still branches on
  `template.kind` for PDF vs `xlsx_binary`. Refactor to loop
  `template.outputs` and dispatch each entry to the right renderer
  (`renderCertificatePdf`, `renderBinaryCertificateXlsx`). Add
  `payroll_tax_certificates.artifacts jsonb` in the same migration, mirror
  the pattern from `payroll_return_runs`, and update
  `src/hooks/payroll/useTaxCertificates.ts` + the tax-certificates UI
  (see `src/components/payroll` — no `TaxCertificatesTab.tsx`; the
  surface lives inside `PayrollWorkspace` and `ReturnsTab` siblings).
- **A4 (publisher):** extend `ReturnTemplateEditor.tsx` and
  `CertificateTemplateEditor.tsx` with a multi-select bound to
  `format_registry`, per-entry `label` / `filename` / `role`. Persist to
  `outputs jsonb`. Add a small `usePackFormatRegistry()` hook querying
  the new table (public-read). The trigger already rejects unknown
  formats so the editor only needs to project the whitelist.
- **A5 (Kenya pack):** back-fill `outputs` on the existing KE templates:
  - `NSSF_RET` → `[{format:'gov_xlsx', role:'primary'}, {format:'csv', role:'audit'}]`
  - `P9` / `P9A` → `[{format:'xlsx_binary', role:'primary'}]`
  Use `supabase--insert`; no pack version bump needed (metadata only).

### PART B remainder
- **B1 canonical bindings:** the KE P9 / P9A pack rows now work through
  the renderer's normaliser, but the underlying JSON is still the array
  shape. Convert to the canonical `{static, monthly_grid}` object in a
  data-migration and add a `CHECK` on `body->>'kind'='xlsx_binary'` rows
  that requires `body->'cell_bindings'->'static'` to be present. This lets
  the renderer drop the normaliser branch next release.
- **B3 Annual Earnings Statement:** template body is now structurally
  valid, but the sections are still generic (`ytd_table` + totals).
  Decide with product whether to publish a KE-specific master (reuse P9
  master with different `header.title` and a subset of columns) or leave
  the generic PDF path in place. If publishing, use the same
  `xlsx_binary` flow as P9.

### PART C wiring
- Import `payrollLifecycleGate.ts` inside
  `generate-tax-certificate/index.ts`: call
  `requireApprovedRunsForYear` right after body validation, before the
  YTD RPC. Map the failure to a `businessError(422, result.code, …)`.
- Import inside `generate-statutory-return/index.ts`: call
  `requireClosedPeriod` after the pack template is resolved, before the
  writers run. Map the failure the same way.
- Add a matching test in `src/test/payroll/` that greps for both call
  sites so future edits can't strip the gate.

### PART D remainder
- Runtime tests (Deno) for the generator: post a fake payload, assert the
  response payload includes `run.artifacts` with the right formats. Live
  in `supabase/functions/generate-statutory-return/*_test.ts`.
- Publisher round-trip test (once A4 lands): load a template with
  `outputs`, edit via `ReturnTemplateEditor`, save, reload, assert
  identity.

### PART F — legacy cleanup (one release after A4 ships)
- Drop `csv_path`, `pdf_path`, `gov_file_path` from `payroll_return_runs`
  once every reader (hook fallback, `ReturnRunHistoryDrawer`,
  `record-return-filing`, download-signed-url edge functions) has been
  moved onto `artifacts`. Search for the string `gov_file_path` and
  `pdf_path` before dropping.
- Drop the `output` scalar on `localization_pack_return_templates` (still
  read by the generator dispatch above) after the loop-`outputs`
  refactor lands.

---

## Enterprise reference points

- Odoo Payroll — `l10n_*_hr_payroll` modules publish `report.report_action`
  with `report_type` as the format registry equivalent.
- SAP HCM — `HR_FORMS` metadata drives layout + format; `PC00_M99_CIPE`
  is the close gate.
- Workday — Report Writer "Output Profile" plus completion status
  ("Complete"/"Confirmed") gate.
- Oracle HCM — BI Publisher output types per template; `Verified` /
  `Prepayments` steps gate downstream artifacts.

All four systems separate the *template definition* from the *format
declaration* and force a *closed period* precondition. That is the
architecture this plan is landing.

---

## Technical file map (updated)

- `supabase/migrations/20260711-232057-*.sql` — pack-declared exports schema.
- `supabase/functions/generate-statutory-return/index.ts` — artifact writes.
- `supabase/functions/_shared/payrollLifecycleGate.ts` — lifecycle gate.
- `src/hooks/payroll/useStatutoryReturns.ts` — surfaces `artifacts`.
- `src/components/payroll/ReturnsTab.tsx` — artifact-driven UI.
- `src/test/architecture/pack-declared-exports.test.ts` — invariants.
- (pending) `supabase/functions/generate-tax-certificate/index.ts`.
- (pending) `src/features/localization/components/ReturnTemplateEditor.tsx`
  and `CertificateTemplateEditor.tsx`.
- (pending) `src/hooks/payroll/useTaxCertificates.ts`.
