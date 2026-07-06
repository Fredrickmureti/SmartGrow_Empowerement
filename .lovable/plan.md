
# Kenya Localization Pack & Publisher — Enterprise-Grade Audit and Uplift

**Scope:** Elevate the *publishing platform* (schemas, editor, versioning, resolver, engines) using Kenya as the reference country. **No tenant data is modified.** Every improvement ships through a new Kenya pack version consumed via the normal `pack_upgrade_proposals` pipeline.

---

## 1. Findings (audit summary)

### 1.1 Statutory template inventory (Kenya)

| Artifact | Publisher surface | Gaps observed |
|---|---|---|
| **P9** Tax Deduction Card (employee, annual) | `certificate_templates` + `certificateSections.ts` | Column entries silently accept objects with `{key\|code\|rule_code}`; header includes not statutorily complete (missing employer PIN, tax office, year band, signature block, statutory footnotes); no monthly *chargeable pay / relief / PAYE* triad column set enforced; no schema. |
| **P10** PAYE monthly return | `return_templates` | No schema enforcing employer PIN, PRN, period, PAYE totals reconciliation to `payroll_liabilities`; export format free-form. |
| **P10A / P10D** annual reconciliations | Not modelled as distinct templates | Missing. |
| **SHIF** monthly byproduct return | `return_templates` | Regenerate path succeeded only after outbox source fix; template lacks contribution-band metadata, employer/employee split header, KRA/SHA reference block. |
| **NSSF** Tier I / Tier II return | `return_templates` | No tier split enforcement in schema. |
| **Housing Levy (AHL)** return | `return_templates` | Missing legal citation, employer/employee 1.5% split proof, remittance-code field. |
| **NITA** levy | Not published | Missing. |
| **Employee certificates** (Certificate of Service, tax-year P9 per employee) | Partial via `certificate_templates` | No standard "employer letterhead + signature + statutory refs" section type. |
| **Remittance advice / bank export** | `bank_export_templates` | Present; not linked back to the originating return for auditor traceability. |

### 1.2 Publisher/editor weaknesses

- `certificate_templates` has **no JSON Schema** in `pack_rule_type_schemas` — publishers can save any shape (the recent `key.replace` crash proved it).
- `TemplateFieldInspector` only checks token references — not **required sections**, **statutory metadata**, or **column shape**.
- No **realistic preview** for certificates (only returns have `PreviewPanel` wired against fixtures).
- No **publish-time lint** rule for certificates equivalent to the one for returns.
- No enforced **legal metadata** on certificate templates (authority, legal reference, effective/sunset dates, revision citation) — the fields that Slice A of the 2026-06-30 audit added for returns.
- No **canonical-data contract**: certificates read directly from `payslip_lines`/`payroll_employee_ytd`; nothing forbids a publisher from writing a template that recomputes from raw inputs.

### 1.3 Architectural weaknesses

- **Schema gap** — only returns and payroll rules go through `pack_rule_type_schemas`; certificates and bank-export bodies do not.
- **Column type polymorphism** — `columns[]` accepts `string | {key|code|rule_code}` inconsistently across renderers; runtime coercion (today's `humanize` fix) hides publisher errors instead of rejecting them at save time.
- **Section vocabulary is undocumented** — `certificateSections.ts` supports three section types; unknown types are silently skipped, so a typo becomes an empty PDF band.
- **Canonical-source drift risk** — no architecture test asserts certificate/return numbers come from `payroll_employee_ytd` (the single YTD projection) rather than re-summed payslip lines.
- **Version fan-out** — `publish-localization-pack-version` snapshots `pack_token_registry` but not `pack_rule_type_schemas`; a schema change is invisible in diffs.

---

## 2. Redesign

### 2.1 Certificate template schema (new)

Add `certificate_template_v2` to `pack_rule_type_schemas` with:

- **Required top-level:** `legal_reference`, `authority_code`, `effective_date`, `revision_citation`, `sections[]`, `columns_contract`, `data_source` (enum: `payroll_employee_ytd` — the only allowed value today).
- **Sections whitelist:** `employer_header`, `employee_header`, `fiscal_period_band`, `monthly_breakdown`, `totals`, `relief_summary`, `signature_block`, `statutory_footnote`. Unknown types **reject at save**, not silently skip.
- **Column contract:** entries MUST be objects `{key: string, header?: string, source: "rule_code"|"category"|"expression", format: "money"|"number"|"date"}`. Legacy string shorthand rejected.
- **Trigger** `trg_assert_pack_payload_valid` extended to fire on `localization_pack_certificate_templates`.

### 2.2 Certificate metadata columns (parity with returns Slice A)

Extend `localization_pack_certificate_templates` with: `authority_id (fk)`, `legal_reference`, `regulation_citation`, `effective_date`, `sunset_date`, `revision_notes`, `submission_channel` (employer|employee|both), `approval_required`. Editor exposes these as first-class fields; legal metadata is pack-owned and non-overridable (mirrors `return-override-legal-metadata-immutable` guard).

### 2.3 Canonical data-source guard

- New shared resolver `_shared/certificateSourceResolver.ts` — the **only** path certificate generation reads YTD figures. Reads `payroll_employee_ytd` + `payroll_periods` + `employees` view.
- New ESLint rule `no-payslip-lines-in-certificates` forbids direct `payslip_lines` reads in `generate-tax-certificate` / `generate-statutory-return`.
- Architecture test `certificate-canonical-source.test.ts`.

### 2.4 Publisher editor uplift

- Promote `CertificateTemplateEditor` from thin wrapper to full editor with:
  - Legal-metadata form (mirrors `ReturnTemplateEditor`).
  - `SchemaForm` driven by `certificate_template_v2`.
  - **Section palette** — publisher picks from the whitelist; unknown types not creatable.
  - **Column builder** — structured rows, live token-registry validation (already extractable from `TemplateFieldInspector`).
  - **Live realistic preview** — render against a `pack_test_fixtures` P9 employee fixture using the actual `generate-tax-certificate` dry-mode path.
  - **Save-block conditions:** unresolved tokens, missing required sections, missing legal metadata, unknown section type, malformed column entry.
- `PackHealthPanel` extended: warns on any `legacy_unvalidated=true` certificate row and any template missing `authority_id` / `legal_reference`.

### 2.5 Publish-time lint

Extend `publish-localization-pack-version` and `lint-localization-pack`:

- Snapshot `pack_rule_type_schemas` alongside `pack_token_registry` (fixes 2.5 gap).
- Reject publish if any certificate template fails v2 schema, has unresolved tokens against snapshot registry, or lacks legal metadata.
- Emit `pack_upgrade_proposals` diff renderer for certificates (ADR 0056 P2.b constraint — one renderer per rule type).

### 2.6 Kenya pack v-next content

Republish the Kenya pack with corrected + newly-added templates:

- **P9** — proper header (employer name/PIN, employee name/PIN, tax year), monthly grid with `chargeable_pay / relief / paye_charged / paye_paid`, totals, statutory footnote citing Income Tax Act CAP 470, signature block.
- **P10** monthly PAYE return — schema-validated, reconciles to `payroll_liabilities` for PAYE.
- **P10A/P10D** annual reconciliations — new templates.
- **SHIF** monthly — contribution bands, employer/employee split, SHA remittance code.
- **NSSF** — Tier I/II split.
- **AHL** — 1.5% split, KRA payment reference.
- **NITA** — new template.
- **Certificate of Service** — country-agnostic template body seeded for Kenya.
- Every template carries `authority_id`, `legal_reference`, `effective_date`, `revision_citation`.

### 2.7 Delivery pipeline (no tenant patching)

1. Migrations add schema rows, columns, triggers, ESLint rule, arch tests.
2. Publisher edits Kenya pack in-editor; new templates saved under existing pack, `pack_versions` bumped via `publish-localization-pack-version`.
3. `pack_upgrade_proposals` fan-out reaches installed tenants; each tenant accepts through the standard inbox on `/hr/payroll/configuration/localization`.
4. No `UPDATE`/`INSERT` against tenant tables in any migration.

---

## 3. Deliverables

- Migrations: certificate metadata columns, schema seed, validator trigger extension, snapshot-list extension, ESLint rule registration.
- Code: `CertificateTemplateEditor` v2, `certificateSourceResolver.ts`, updated `certificateSections.ts` (strict), updated `publish-localization-pack-version` + `lint-localization-pack`, updated `generate-tax-certificate` to use resolver.
- Content: new Kenya pack version with corrected/added templates authored via the editor (seed migration writing to `localization_pack_*_templates` under the *pack*, not tenant tables).
- Tests: `certificate-canonical-source.test.ts`, `certificate-template-v2-schema.test.ts`, `certificate-legal-metadata-immutable.test.ts`, publisher save-gate test.
- Docs: new ADR *"0060 — Certificate template parity with returns"* and update to `docs/audit/2026-06-30-statutory-returns-remittances.md`.

## 4. Success criteria

- No path in the codebase can render a Kenya statutory document from anything other than `payroll_employee_ytd`/`payroll_liabilities` (guarded by ESLint + arch test).
- Publisher cannot save a certificate template that is missing legal metadata, references unknown tokens, or uses an unknown section type.
- A new country pack can add a P9-equivalent by supplying a schema-valid template — zero engine code change.
- Existing tenants receive the new Kenya pack version through the standard upgrade inbox; no tenant migration or backfill required.

## 5. Explicitly out of scope

- Touching `payroll_runs`, `payslips`, `payroll_return_runs`, or any tenant business data.
- Regenerating any existing tenant document.
- Building the deferred P2.a/P2.c/P2.d tracks from ADR 0056 (dependency graph, simulator, 4-eyes) — this plan keeps their integration points intact but does not deliver them.
