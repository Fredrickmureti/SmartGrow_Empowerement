
# Enterprise Payslip Audit — Verdict & Redesign Plan

## Overall verdict

**Structurally sound, presentationally sub-enterprise.** The pipeline is honest — a single `payslip_lines` table drives both the on-screen dialog (`PayslipDetailDialog`) and the PDF (`generate-payslip-pdf`) through one shared `payslipClassifier`, one shared `payslipHeader` RPC, one shared `breakdownAdaptor`, and one shared `PayslipLineExplainer`. Provenance (`input_ref`), correction lineage (`PayslipCorrectionBanner`), lifecycle journal (`PayslipEventsTimeline`), YTD block, and rule-version chips all exist. That is *ahead* of Sage and roughly at parity with Odoo Enterprise on data completeness.

Where it falls short of SAP HCM / Workday / ADP / Ceridian is **information architecture, visual hierarchy, and progressive disclosure of calculations**. The PDF is a single flat two-column report with breakdown rows inlined as sub-notes underneath every deduction; the on-screen admin view is a raw 5-column table with a code column, a category badge, and no summary story. Neither surface tells the "gross → statutory → tax → voluntary → net" narrative the way enterprise payslips do, and the calculation explainer competes with — rather than layers under — the pay data.

The engineering root cause is a single one: **the payslip renderer treats `payslip_lines` as a flat list keyed only by `category`**. There is no *section-band* concept between "line bucket" and "document". Everything downstream — visual hierarchy, ordering, subtotals, explainer placement — inherits that flatness.

---

## Dimension-by-dimension assessment

### 1. Information architecture — **B-**
- Correct top-level sections (Employer, Employee, Earnings, Deductions, Employer Contributions, Net Pay, YTD).
- **Missing intermediate bands** inside Deductions. Mature systems split deductions into three ordered bands:
  1. **Statutory contributions** (NSSF, SHIF, AHL) — legally mandated, pre-tax.
  2. **Income tax** (PAYE, net of reliefs) — the biggest single line for most employees, deserves its own band with the taxable-base build-up visible.
  3. **Post-tax deductions** (loans, garnishments, custom voluntary).
   Today all three collapse into one `DEDUCTIONS` list ordered only by `sequence`.
- **No "Taxable pay" pivot line.** The single most-audited number on a payslip in every jurisdiction is the taxable base PAYE was computed on. It now lives *inside* the PAYE explainer's `explanation[]` prose. It should be a first-class row between the statutory band and the tax band, matching `payslips.taxable_base` (the column that was just persisted).
- **Employer contributions correctly placed after net pay** (Odoo / Workday convention). Good.
- **YTD is a compact 3-line summary.** Correct call — per-rule YTD belongs on the tax certificate, not the monthly payslip.

### 2. Visual hierarchy — **C+**
- PDF: `_isHeader / _isSubtotal / _isGrandTotal / _isSubnote` flags exist but resolve to weight/underline only — no whitespace bands, no right-column alignment for subnotes, no section rules. A payroll officer scanning 200 payslips cannot land the eye quickly.
- Dialog (admin): a raw shadcn `<Table>` with `Code | Label | Category | Employee | Employer`. The `Code` and `Category` columns are engineer-facing and add noise; enterprise admin views (Workday "Pay Result" drill) lead with the human label and hide the code behind an "i".
- Net Pay is emphasised (`_isGrandTotal`, primary color card) — that part is correct.
- Gross / Deductions / Net summary cards on the dialog are good; the PDF has no equivalent hero band.

### 3. Calculation explainability — **B**
- Per-line explainer popover with bracket breakdowns, rule-version chip, source drill-down link — this is genuinely enterprise-grade on screen and *ahead* of Odoo.
- PDF explainer is **too aggressive**: it inlines every `employeeRow` of every deduction as sub-notes under the line, producing a wall of `From … to … × 10% = …` rows that break the payslip's readability. Enterprise PDFs (ADP, Ceridian) put this in an optional appendix or hide it behind a "detailed statement" variant. `payroll_settings.pdf_show_explainer` exists as a global boolean but there is no *per-document* mode (summary vs. detailed).
- Taxable-base build-up narrative (statutory deductibles → exemptions → reliefs) is compressed into `explanation[]` prose rather than rendered as an itemised sub-table.

### 4. Cognitive load — **C**
- First-time employee reading the PDF: has to scroll past 15+ sub-note rows to find Net Pay if PAYE has 3 brackets. Reliefs prose is dense.
- Payroll officer: has to mentally re-group Deductions into statutory / tax / voluntary bands.
- Auditor: has all the data but must open the popover on every line; there is no single "reconciliation view" that lays out taxable_base → paye_before_relief → reliefs → paye alongside the persisted columns.

### 5. Accountant usability — **B-**
- Admin dialog has the right raw material (all lines, all columns). Missing: totals per band, per-line running subtotal, tie-out row showing `gross − Σ deductions = net`.

### 6. Employee usability — **C+**
- Portal mode correctly hides employer contributions and drops the audit journal. Correct enterprise convention.
- Missing on the portal: a plain-English "How your pay was calculated this month" narrative (Workday "Pay Explained"), and a comparison chip vs. last period.

### 7. Auditor usability — **B**
- Provenance (`input_ref`), rule versions, and correction lineage all present. Strong.
- Missing: PAYE reconciliation panel using the new `taxable_base` / `paye_before_relief` columns, and an explicit rule-trace link (data is in `payroll_rule_traces` but not surfaced).

### 8. Regulatory / compliance — **A-**
- A4 paper pin enforced (`assertStatutoryPaper`).
- Immutability triggers scanned for country tokens.
- Country-agnostic statutory ID rendering via `payslip_header` RPC + `pack_requirements` labels.
- Employer statutory IDs default OFF (Odoo-aligned) with a tenant toggle. Correct.
- Gap: no localisation-pack-driven "mandatory payslip fields" checklist enforced at render time (KE Employment Act §20 requires overtime hours, leave days taken, etc.); today it depends on the pack shipping the right lines.

### 9. Architectural weaknesses uncovered while tracing the pipeline
1. **Section band is not a first-class concept.** `payslip_lines.category` is a bucket, not a display band. There is no `display_section` (or derived equivalent) that groups statutory-vs-tax-vs-voluntary within Deductions. The renderer has to re-derive it from `category` + `rule_code` heuristics.
2. **`taxable_base` and `paye_before_relief` are persisted but not rendered anywhere.** The columns were added last turn; the PDF and dialog still read the taxable base out of `explanation[]` prose.
3. **PDF renderer builds rows imperatively.** `rows.push({...})` for 400 lines with sentinel flags is untestable and prevents a proper "summary vs. detailed" variant.
4. **`Code` and `Category` columns leak engine vocabulary into the admin UI.** Enterprise admin views separate the *human* payslip from a *technical* rule-trace tab.
5. **Reliefs are prose, not structured rows.** `explanation[]` is a `string[]`. A reliefs table (`Personal relief | −2,400`, `Insurance relief | −250`, `AHR relief | −833`) belongs in the same structured shape as bracket rows.
6. **No "pay comparison" surface.** Every enterprise portal shows Δ vs prior period. The data is one query away (`payslips` filtered by employee_id ordered by pay_period_end).

---

## Recommendations (in priority order, minimal surface area)

### R1 — Introduce a `display_section` derivation (no schema change)
Add a pure helper `payslipSection(line): "earning" | "statutory_deduction" | "income_tax" | "post_tax_deduction" | "employer_contribution" | "info"` in `_shared/payslipSection.ts` (mirrored in `src/lib/payroll/`). Derive from `category` + `rule_type` (`bracket_progressive` → income_tax; `statutory_employee` → statutory_deduction; everything else with employee_amount>0 → post_tax_deduction). This is the single change that unlocks R2–R4 in both surfaces without touching the engine.

### R2 — Restructure the Deductions band in both PDF and dialog
Render as three sub-bands with a subtotal each:
```text
STATUTORY CONTRIBUTIONS       -Σ
   NSSF Tier I                -360.00
   SHIF                       -1,375.00
   AHL                        -687.50
TAXABLE PAY                   =X          ← from payslips.taxable_base
INCOME TAX                    -Σ
   PAYE (before reliefs)      -Y          ← from payslips.paye_before_relief
   Personal relief            +2,400.00
   Insurance relief           +250.00
   PAYE payable               -Z
POST-TAX DEDUCTIONS           -Σ
   Loan repayment             -...
   Voluntary pension          -...
TOTAL DEDUCTIONS              =ΣΣΣ
```
Uses the two columns just persisted; no engine change.

### R3 — Split explainer into two variants
- **PDF summary mode (new default):** show the deduction line only. No inline brackets.
- **PDF detailed mode (existing `pdf_show_explainer=true`):** move brackets + reliefs into a **"Calculation appendix"** at the end of the PDF, one panel per non-trivial deduction, cross-referenced by a small `[A1]` marker on the deduction line. Matches ADP / Ceridian detailed statements.
- **Dialog:** keep the popover as-is (it's the best-in-class surface).

### R4 — Clean up the admin dialog table
- Drop the `Code` column into the popover header (already shown there).
- Drop the `Category` column; replaced by section grouping from R1.
- Add per-section subtotal rows and a tie-out footer `Gross − Deductions = Net`.
- Keep the 3-card Gross/Deductions/Net hero (it's the one thing the PDF should also gain).

### R5 — Render reliefs as structured rows, not prose
Extend the PAYE explainer's `source` jsonb to include `reliefs: [{code, label, amount}]` (engine already computes these; just persist them into `source`). Adaptor emits them as a proper sub-table. Deprecate the string-only `explanation[]` for reliefs (keep it for legal-basis footnotes only).

### R6 — Auditor reconciliation panel (admin dialog, collapsed by default)
New collapsible section: **"PAYE reconciliation"** reading `payslips.taxable_base`, `payslips.paye_before_relief`, and joining `payroll_rule_traces` for the PAYE rule. Renders the exact ladder:
`Gross taxable → − statutory deductibles → − exemptions → = taxable_base → × brackets → paye_before_relief → − reliefs → = PAYE`.
Read-only; zero engine impact.

### R7 — Portal: "How your pay was calculated" narrative + prior-period delta
One paragraph auto-generated from the section subtotals, plus a `Δ vs {previous_period}` chip on the Net Pay card. Data comes from a single extra query. This is the change with the highest employee-trust ROI.

### R8 — Structured PDF builder (refactor, not a redesign)
Replace the `rows.push({...})` sequence with a small `PayslipDoc` object composed of `sections[]`, each with `title / lines[] / subtotal / notes[]`. Feeds the same `generateReportPdf` primitive. Prerequisite for R3 (summary vs. detailed) being testable.

### R9 — Localization-pack "mandatory payslip fields" gate
Extend `pack_requirements` with a `payslip_field` kind (e.g. `overtime_hours`, `leave_days_taken`). `generate-payslip-pdf` fails soft with a `header.notes` warning if a required field is absent. Keeps compliance enforcement in the pack, not the renderer.

### What NOT to do
- Do **not** add per-rule YTD to the monthly payslip. Current compact YTD is correct.
- Do **not** move employer contributions above net pay. Current placement matches Odoo/Workday.
- Do **not** localise any of the above in the renderer — every new label/threshold flows through the pack.
- Do **not** touch the engine. Every recommendation is a renderer / adaptor / read-side change.

---

## Suggested execution order (if approved)
1. R1 (section derivation) + R4 (dialog cleanup) — one PR, no schema, immediate visual win.
2. R2 (banded deductions) + R5 (structured reliefs in `source`) — one PR, uses columns already persisted.
3. R8 (structured PDF builder) then R3 (summary vs. appendix PDF) — one PR, largest change, gated behind the existing `pdf_show_explainer` setting.
4. R6 (auditor reconciliation panel) — one PR, admin-only.
5. R7 (portal narrative + delta) — one PR, portal-only.
6. R9 (pack mandatory fields) — separate ADR + pack schema bump.
