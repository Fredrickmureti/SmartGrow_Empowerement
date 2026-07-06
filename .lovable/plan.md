
# ADR-0060 Follow-Through — Close the Remaining Gaps

## 1. Audit result vs. previous plan

I re-ran the certificate architecture suite (6 tests, 3 files — all green) and traced every claim in `.lovable/plan.md` against the code.

**Genuinely landed (do NOT redo):**
- Metadata columns + constraint + indexes on `localization_pack_certificate_templates` (migration `20260706001915`).
- `certificate_template_v2` JSON Schema seeded into `pack_rule_type_schemas`.
- `trg_assert_certificate_template_body_valid` trigger + `assert_certificate_template_body_valid()` function (legacy bodies flagged, non-conforming bodies rejected).
- `publish-localization-pack-version` now (a) snapshots `pack_rule_type_schemas` and (b) hard-fails publish on missing authority / legal ref / `legacy_unvalidated=true` certificates.
- `CertificateTemplateEditor` v2 with legal-metadata form, section palette from the v2 whitelist, `TemplateFieldInspector` wired, save-blocked on missing required sections / metadata / unresolved tokens.
- `useTemplateOverrides` write path proven (by test) to never forward legal-metadata columns for the certificate kind.
- Kenya P9A body refreshed and Certificate of Service seeded — pack rows only, no tenant writes.
- ADR `0060-certificate-template-parity.md` published.
- Architecture tests: `certificate-canonical-source`, `certificate-legal-metadata-immutable`, `certificate-template-publishing-gates`.

**Promised in `.lovable/plan.md` but not delivered:**
1. `_shared/certificateSourceResolver.ts` — never created. `generate-tax-certificate` calls `payroll_employee_ytd_rollup` inline, so there is no single-writer helper mirroring `returnSourceResolver.ts`.
2. ESLint rule `no-payslip-lines-in-certificates` — not registered in `eslint.config.js`. Only the arch test guards this today.
3. Live realistic **preview** for certificates (parity with the return editor's `PreviewPanel`) — the editor has no preview at all.
4. `certificate-template-v2-schema.test.ts` — missing.
5. Publisher save-gate component test — missing.
6. Kenya pack **version bump / proposal fan-out**: migration `20260706001915` mutates pack rows in place without inserting a new `pack_versions` row or calling `publish_pack_version_snapshot`, so no `pack_upgrade_proposals` are generated. Existing tenants will not be offered the corrected P9A / new Certificate of Service through the standard update inbox — the whole point of the exercise.
7. `pack_upgrade_proposals` diff renderer for certificates (ADR-0056 P2.b: one renderer per rule type).
8. `PackHealthPanel` warning for `legacy_unvalidated=true` / missing metadata.

Everything else in the original enterprise-audit prompt (return-side Slice A, P10/AHL/NSSF/NITA metadata, filter legal-basis, override immutability) was already landed by prior work (`20260630225031`, `return-override-legal-metadata-immutable.test.ts`, etc.) — leave those alone.

## 2. Remaining work

### 2.1 Single-writer contract for certificate reads
- Create `supabase/functions/_shared/certificateSourceResolver.ts` exporting `resolveCertificateYtd({ admin, employeeId, fiscalYear })` — the only path allowed to call `payroll_employee_ytd_rollup` for certificate generation, returning `{ rows, totals, provenance }`.
- Refactor `generate-tax-certificate/index.ts` to consume the resolver (drops ~50 lines of inline rollup/provenance code, keeps behaviour identical).
- Extend `certificate-canonical-source.test.ts` to also assert the resolver is the only caller of `payroll_employee_ytd_rollup` inside the certificate function tree.

### 2.2 ESLint guard (defence-in-depth)
- Add a small custom rule (or `no-restricted-syntax` entry, whichever is lighter for this repo) in `eslint.config.js` forbidding `payslip_lines` string literals and `.from("payslip_lines")` under `supabase/functions/generate-tax-certificate/**` and `supabase/functions/_shared/certificate*.ts`.
- Registered rule name: `no-payslip-lines-in-certificates` (matches ADR wording).

### 2.3 Publisher preview panel
- New `CertificateTemplatePreview.tsx` that renders the live `sections[]` against a canned fixture from `pack_test_fixtures` (fall back to a static in-file P9A sample if none exists), using the same section renderer as the runtime (`certificateSections.ts`) — no PDF, HTML preview only.
- Slot it into the right-hand column of `CertificateTemplateEditor` next to the `TemplateFieldInspector` so publishers see the document redraw as they edit.

### 2.4 Missing tests
- `certificate-template-v2-schema.test.ts` — reads the migration, snapshots the JSON schema, and asserts (a) `data_source` enum is `["payroll_employee_ytd"]`, (b) section-type enum matches the editor's `SECTION_TYPES`, (c) legacy string-shorthand columns rejected.
- `certificate-editor-save-gate.test.tsx` — mounts `CertificateTemplateEditor`, drives it into each blocking state (missing authority, missing required section, unknown section type via prop injection, unresolved token) and asserts the Save button is disabled + the destructive alert lists the reason.

### 2.5 Kenya pack v-next fan-out (critical — restores the whole "tenant upgrades through the inbox" contract)
- New migration `<ts>_publish_kenya_pack_v_next.sql` that, inside a `DO $$` block:
  1. Reads current `latest_version` for the KE pack.
  2. Bumps semver (patch) and inserts a `pack_versions` row with `publisher_notes` citing ADR-0060.
  3. Calls the existing `publish_pack_version_snapshot(pack_id, new_version_id)` SQL function (already used by `publish-localization-pack-version`) so the version snapshot includes the refreshed P9A and new Certificate of Service.
  4. Enqueues `pack_upgrade_proposals` for every installed tenant of the KE pack via the same helper the edge function uses (`propose_localization_pack_upgrade` / `propose-localization-upgrades`).
- No `UPDATE` / `INSERT` against tenant tables — only pack + proposal fan-out.

### 2.6 Upgrade-proposal diff renderer for certificates
- Extend `pack_upgrade_proposals` renderer registry (currently returns- and rule-aware) with a `certificate_template` renderer that diffs `sections[]`, `columns` and legal metadata, so accepting the KE v-next in the inbox shows a legible diff, not a raw JSON dump.

### 2.7 Publisher health surface
- `PackHealthPanel` — add two rows: `Legacy certificate templates (n)` (any row with `legacy_unvalidated=true`) and `Certificates missing legal metadata (n)`; link each to the editor row.

## 3. Explicitly out of scope
- Any `UPDATE` / `INSERT` on tenant business tables. Kenya v-next reaches tenants only through the standard inbox.
- ADR-0056 P2.a/P2.c/P2.d tracks (dependency graph, simulator, 4-eyes) — still deferred.
- Other countries: this closes the Kenya reference implementation; adding a second country pack is a follow-up.

## 4. Success criteria
- `bunx vitest run src/test/architecture/certificate-*` still green, plus the two new tests.
- `rg -n "payslip_lines" supabase/functions/generate-tax-certificate supabase/functions/_shared/certificate*` returns zero hits and `eslint` fails on any regression.
- `generate-tax-certificate` produces byte-identical output after the resolver refactor (verified by an integration smoke test against a fixture employee).
- After applying the Kenya v-next migration, `select code, version from pack_versions where pack_id = KE order by created_at desc limit 2;` shows the bumped version, and every installed KE tenant has one new pending row in `pack_upgrade_proposals`.
- Opening the KE pack in the publisher UI shows the preview redrawing live, and `PackHealthPanel` reports 0 legacy / 0 missing-metadata certificate templates.

## 5. Technical details

Files added:
```
supabase/functions/_shared/certificateSourceResolver.ts
supabase/migrations/<ts>_publish_kenya_pack_v_next.sql
src/features/localization/components/CertificateTemplatePreview.tsx
src/test/architecture/certificate-template-v2-schema.test.ts
src/test/architecture/certificate-editor-save-gate.test.tsx
```

Files modified:
```
supabase/functions/generate-tax-certificate/index.ts   # use resolver
src/features/localization/components/CertificateTemplateEditor.tsx  # slot in preview
src/features/localization/components/PackHealthPanel.tsx            # + 2 warnings
src/test/architecture/certificate-canonical-source.test.ts          # + resolver-only assertion
eslint.config.js                                                    # + guard rule
supabase/functions/publish-localization-pack-version/index.ts       # certificate diff renderer wiring (if renderer lives here)
```

No schema-shape changes; no changes to tenant tables. Migration 2.5 uses only existing helper functions and `pack_versions` / `pack_upgrade_proposals` — the same publish path the edge function uses.
