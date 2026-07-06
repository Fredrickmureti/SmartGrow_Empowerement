
## Verified state (independent audit)

I re-read the original brief, the previous agent's `.lovable/plan.md`, and the code. Confirmed against the tree, not the notes:

**Landed (verified)**
- `supabase/functions/_shared/pdf/certificateRenderer.ts` (804 lines) — dedicated section-based renderer with per-section draw functions. Real, not a stub.
- `generate-tax-certificate/index.ts` switched to it; monthly RPC caller now reads rule codes from `columns[].key` as well as `rule_codes[]`.
- `certificate_template_v2` JSON-Schema gate is enforced in `publish-localization-pack-version` (rejects legacy pre-v2 bodies) and `_shared/certificateSections.ts` (server-side whitelist).
- KE P9 template body migration `20260706001915_*.sql` is present and carries the richer section set.
- `CertificateTemplateEditor` is section-based (`sections[]` state, add/remove/move), not a raw JSON blob for the section list.

**Explicitly deferred by the previous agent (still open)**
1. WYSIWYG editor preview using the same renderer (plan item 4).
2. Publish-time visual QA gate in `lint-localization-pack` (plan item 5).
3. ~~Monthly-breakdown RPC canonical-source alignment~~ **DONE (dense-grid variant).** RPC now emits a canonical 12-row × requested-rule-code grid, zero-filled where no posted payslip exists, and tightened to statuses `approved`/`posted`/`paid`. Data source stayed `payslip_lines` (only source with a month dimension); `payroll_employee_ytd` is reserved for YTD totals per ADR-0060.

**Gaps the previous plan under-scoped (found during this audit)**
4. Kerning/font fix in `accountantMono` (plan item 3) — no evidence it landed; no golden-image test in the tree.
5. Editor still exposes free-text `Textarea`s inside sections (column keys, footnote text, token strings). Publishers can type invalid token paths and unknown column keys that only fail at render time. Needs a **token picker** + **column picker** bound to the schema, matching the "no raw developer surface" requirement.
6. `ReturnTemplateEditor` (790 lines) and the statutory-return renderer path have **not** been migrated to the same section-based architecture. The brief explicitly calls out P10 / PAYE returns / NSSF / SHIF / Housing Levy / remittance schedules — today only certificates use the v2 renderer, so returns will regress to the same "developer report with a title stapled on top" shape the P9 did.
7. Publish gate does not check **statutory completeness** per document class (e.g. a P9 without `employer_header` + `employee_header` + `signature_block` + `statutory_footnote` should refuse publish). The schema whitelists section types but does not require the mandatory set.
8. No `pack_upgrade_proposal` has actually been emitted for the improved KE P9 — the migration mutates seed data directly. Tenants on an installed older pack version won't see the improved template through the normal upgrade flow, which contradicts the brief ("do not patch the current tenant … arrive through the normal upgrade flow").

## What to build (in this order)

### Phase A — finish the renderer contract (unblocks everything else)

**A1. Monthly projection is canonical and dense. ✅ SHIPPED.**
`payroll_employee_monthly_breakdown` now returns a dense 12-row × requested-rule-code grid, zero-filled from the fiscal calendar, and only includes payslips in statuses `approved`/`posted`/`paid`. Source stayed `payslip_lines` — that's the only table with a month dimension; `payroll_employee_ytd` remains the canonical YTD-total source per ADR-0060 (used by the totals section, not the monthly grid).

**A2. Kerning fix + golden image.**
Replace `accountantMono` with a font whose space glyph survives at all sizes (pdf-lib's bundled `Helvetica`/`Courier`, or embed a subsetted WOFF with `\u0020` retained). Add a Deno test that renders a fixture P9 and asserts the text layer contains `"P9 — Tax Deduction Card"` and `"Month"` as single tokens (no mid-word gaps).

**A3. Statutory completeness rules per document class.**
Introduce `_shared/certificateCompleteness.ts` with a table:
```
p9  → requires: employer_header, employee_header, fiscal_period_band,
                monthly_breakdown, ytd_table, relief_summary,
                signature_block, statutory_footnote
p10 → requires: employer_header, period_band, employer_totals,
                signature_block, statutory_footnote
cert_of_service → requires: employer_header, employee_header,
                            period_of_service, signature_block
```
Wire into both `publish-localization-pack-version` (hard fail) and the editor (inline "Add missing section" prompt).

### Phase B — publisher UX (removes the developer surface)

**B1. WYSIWYG preview.**
Extract `certificateRenderer` into a shared module runnable in the browser (pdf-lib is isomorphic). `CertificateTemplateEditor` gains a right-hand preview pane that renders the exact same PDF against a per-country fixture dataset. Any edit re-renders within 300 ms. This is the "publisher sees what the tenant will see" gate.

**B2. Token + column pickers, remove free-text where it's really an enum.**
Replace the current `Textarea`s that hold column keys, token paths, and rule codes with:
- **Column picker** — driven by the `certificate_template_v2` section schema per section type.
- **Token picker** — dropdown of resolved tokens exposed by `pack_token_registry` for the pack's country (employer.pin, employee.kra_pin, period.start, etc.).
- **Statutory-wording library** — pack-level reusable snippets (Income Tax Act CAP 470 §37, NSSF Act §20, etc.), inserted as tokens, not typed prose.
Free text stays only for genuinely free content (footer note, publisher comments).

**B3. Publish-time visual QA gate.**
Extend `lint-localization-pack` to render each template through the certificate renderer against a synthetic fixture and reject publish when:
- Any required section renders empty (zero rows / zero text).
- Any section overflows page width.
- Rendered PDF byte size falls under a per-doc-class floor (shallow-output proxy).
- Statutory completeness (A3) fails.

### Phase C — extend the same architecture to returns / remittances

**C1. `return_template_v2` schema + renderer.**
Introduce `return_template_v2` (mirrors certificate schema) with section types tuned for returns: `employer_header`, `period_band`, `employee_line_grid`, `employer_totals`, `reconciliation_block`, `signature_block`, `statutory_footnote`, `remittance_summary`. Add `_shared/pdf/returnRenderer.ts` reusing the same PdfBuilder primitives.

**C2. Migrate `generate-statutory-return`.**
Switch off `generateReportPdf` for returns, same way certificates were switched. Preserve the existing `columns[]`/`rows[]` fallback behind a `pack_versions.metadata.renderer` flag so already-installed packs keep working until upgraded.

**C3. Migrate `ReturnTemplateEditor`.**
Same section-based UI as `CertificateTemplateEditor` (B1 + B2 preview and pickers).

### Phase D — ship via the upgrade flow (not a data patch)

**D1. Convert the KE P9 body change into a `pack_upgrade_proposal`. ✅ SHIPPED.**
- Published KE pack version **2026.5.0** with a detailed changelog describing the P9 section-based rewrite (data-only insert, idempotent, non-breaking, no tenant data migration required).
- Backfilled `pack_version_id` on `P9`, `P9A`, and `CERT_OF_SERVICE` template rows so audit provenance points at the version that introduced the v2 body.
- Fanned out `pack_upgrade_proposals` (status `pending`) to every installed KE tenant whose active pack version is not `2026.5.0`. The one installed tenant now sees a pending `2026.3.0 → 2026.5.0` proposal in the Upgrades screen.
- Added architecture test `certificate-body-change-requires-pack-version-bump.test.ts` — any future migration that writes to a certificate template `body` must also `INSERT INTO public.pack_versions ... 'published'` in the same migration, or explicitly grandfather itself. Blocks silent seed mutations going forward.

**D2. Golden fixture set per country pack.**
`localization_packs/<country>/fixtures/` — one synthetic employer + employees + a posted fiscal year, used by A2, B1, and B3. Cheap CI insurance that a new pack version renders the same shape as the previous one.

## Technical notes

- No changes to already-issued `payroll_tax_certificates` — historical output stays as it was, per the brief.
- Feature flag: `pack_versions.metadata.renderer = "v2"` (certificates) and `= "v2-returns"` (returns). Older packs continue to use `generateReportPdf`.
- `certificate_template_v2` schema is unchanged; completeness rules (A3) live in application code so we can evolve per country without a schema migration.
- Tests: golden-PDF snapshot per required section, `render_refusal_test.ts` extended with completeness failures, SQL test for the monthly projection.

## Risks

- **Font swap** may shift line heights and reflow every certificate. Golden snapshots catch it; expect a one-time re-baseline.
- **Browser pdf-lib bundle size** for the WYSIWYG preview (~350 KB gzipped). Load the preview lazily behind the editor route.
- **Return-template migration** is the largest phase; some countries may have templates that don't map cleanly to the section vocabulary. Solution: pack-level custom section types allowed only if the pack ships a matching renderer plugin (out of scope for this pass; document as a v3 extension point).

## Success criteria

- A publisher can create a full P9 / P10 / return / remittance in the editor without seeing JSON, raw column keys, or unresolved tokens.
- Publish fails loudly when a statutory document is missing a required section.
- The KE P9 delivered to tenants through the upgrade flow visually matches the enterprise mockup in the previous agent's message (bands, totals, signatures, footnote), and the same is true for returns after Phase C.
- Adding a new country pack requires only a fixture + template bodies — no renderer or editor code changes.

## Out of scope (deferred by design)

- Multi-language rendering.
- Non-KE country packs beyond fixtures needed to prove the platform.
- Editor plugin system for custom section types (call it out as v3).
