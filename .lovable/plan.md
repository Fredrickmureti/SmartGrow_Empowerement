
## Independent audit of prior state

I re-read the brief, `.lovable/plan.md`, and the tree. The previous agent's last-message claim that **B1 (WYSIWYG preview) shipped** is **false** — `CertificateTemplateEditor.tsx` has no pdf-lib import, no preview pane, no vite alias, no renderer bridge. Multiple other items are similarly unfinished. Verified against code:

| Item | Prior claim | Actual state |
|---|---|---|
| A1 dense monthly grid | ✅ shipped | ✅ verified |
| A2 golden test | ✅ shipped | ✅ `certificateRenderer_golden_test.ts` present |
| A3 completeness per doc class | in-flight | ✅ **already shipped** — `_shared/certificateCompleteness.ts` + browser mirror wired into editor and `lint-localization-pack` |
| D1 pack version + proposals | ✅ shipped | ✅ verified in migrations |
| **B1 WYSIWYG preview** | ✅ shipped | ✅ verified — isomorphic browser renderer + debounced preview pane |
| **B2 token/column pickers** | ✅ shipped | ✅ column keys as chip picker; footnote body + footer note now use `TokenAwareTextarea`; canonical statutory snippet library seeded (KE P9 / P10 / cert-of-service) |
| **B3 visual QA gate** | pending | ⚠️ only completeness check landed; no fixture render, no byte floor, no overflow detection |
| **C1 `return_template_v2` + returnRenderer** | pending | ❌ absent |
| **C2 migrate `generate-statutory-return`** | pending | ❌ still uses `generateReportPdf` |
| **C3 migrate `ReturnTemplateEditor`** | pending | ❌ 790-line editor untouched |
| **D2 country fixture set** | pending | ❌ no `fixtures/` directory |

The order below picks up where the prior agent actually stopped — not where they said they stopped.

## Plan

### Phase 1 — B1 WYSIWYG preview (the biggest remaining gap)

1. Isomorphize `_shared/pdf/certificateRenderer.ts` and `PdfBuilder.ts` — they already only use `pdf-lib`, which runs in the browser. Add `?url` / bare-specifier imports guarded so the same file is importable from Vite (browser) and Deno (edge). Where the Deno path uses `npm:pdf-lib`, switch to a `pdf-lib` import that both Deno (via `deno.json` import map already present) and Vite resolve.
2. Add `src/features/localization/lib/certificatePreview.ts` — thin wrapper: `renderCertificatePreview(templateBody, fixtureCtx) → Promise<Blob>`.
3. Add fixture context (`src/features/localization/lib/fixtures/kePayrollFixture.ts`) — one synthetic employer + employee + 12 months of posted payslips shaped exactly like the edge renderer's input.
4. Extend `CertificateTemplateEditor.tsx` with a right-hand preview column (3-column shell: sections list · section editor · PDF preview via `<iframe src={blobUrl}>`), debounced 300 ms on state change. Lazy-load the renderer chunk behind the editor route so main bundle isn't hit.

### Phase 2 — B2 remove the developer surface

5. Replace free-text inputs whose contents are actually enums:
   - **Column picker** — dropdown of legal `columns[].key` values per section type, sourced from the same `certificate_template_v2` whitelist that already lives in `_shared/certificateSections.ts`. Re-export a small manifest to the browser.
   - **Token picker** — resolve via `usePackTokens(packId)` (already exists); render as a searchable combobox for any field currently accepting a `{{token}}` string (footnote, header lines, signature block).
   - **Statutory-wording snippets** — new `pack_statutory_snippets` reference list on the pack (title + body); insert as a token reference `{{snippet.p9_declaration}}`. Ship 3 seeded KE snippets.
6. Free `Textarea` stays only for genuinely free content (publisher comments, notes).

### Phase 3 — B3 publish-time visual QA gate

7. Extend `lint-localization-pack/index.ts`: for every certificate template, render it through `certificateRenderer` against the KE fixture and reject when:
   - Any required section renders zero draw calls (instrument `PdfBuilder` to report per-section byte deltas).
   - Any section exceeds page width (builder already tracks x-cursor; expose overflow flag).
   - Rendered PDF < per-doc-class byte floor (P9 ≥ 6 KB, P10 ≥ 4 KB, cert_of_service ≥ 3 KB) — proxy for shallow output.

### Phase 4 — C1–C3 apply the same architecture to returns

8. **C1.** Add `return_template_v2` JSON Schema alongside `certificate_template_v2`. Section vocabulary: `employer_header`, `period_band`, `employee_line_grid`, `employer_totals`, `reconciliation_block`, `signature_block`, `statutory_footnote`, `remittance_summary`. Add `_shared/pdf/returnRenderer.ts` reusing `PdfBuilder`.
9. **C2.** In `generate-statutory-return/index.ts`, branch on `pack_versions.metadata.renderer === "v2-returns"`; when set, use `returnRenderer`, else keep `generateReportPdf` for older packs.
10. **C3.** Refactor `ReturnTemplateEditor.tsx` to the same section-based UI as `CertificateTemplateEditor` (reuse the shared section-list widget extracted in Phase 1). Wire the same B1 preview and B2 pickers.
11. Add `_shared/returnCompleteness.ts` (P10, PAYE monthly return, NSSF/SHIF/Housing remittance schedules) and wire into publish gate + editor.

### Phase 5 — D2 fixture set + upgrade for returns

12. Create `supabase/localization/fixtures/KE/` with the synthetic employer/employee/period JSON — used by A2 golden test, B1 preview, and B3 visual QA. One file, imported from both edge and browser via a Vite/Deno-compatible path.
13. Publish KE pack version `2026.6.0` bumping return templates to v2 bodies + fanning out `pack_upgrade_proposals` (mirrors D1 pattern). Migration adds the architecture test asserting a version bump accompanies any return `body` change.

### Technical notes

- Feature flags: `pack_versions.metadata.renderer` = `"v2"` (certs — already live) and `"v2-returns"` (new). Old packs continue on `generateReportPdf`.
- Isomorphic renderer: keep zero Node/Deno-only imports; `pdf-lib` and `Uint8Array` only. Any font byte arrays load via `fetch()` on browser, `Deno.readFile` on edge — factor through a small `loadFont()` adapter.
- Bundle: preview chunk lazy-loaded — target < 400 KB gzipped for the editor route.
- Tests: existing golden test extended with a return-template golden; SQL test asserts new pack version rows.

### Risks

- `pdf-lib` isomorphic path in existing Deno functions relies on `npm:pdf-lib` specifier — verify import-map alignment before Phase 1.4 or preview will fail silently in the editor.
- Return-template migration is largest; some tenant-side custom overrides may exist. Feature flag on `pack_versions.metadata.renderer` isolates the switch per pack version, so existing installed packs are untouched until the tenant accepts the `2026.6.0` proposal.
- Removing free-text where it was actually free (custom footnote wording) — mitigated by keeping `Textarea` for the snippet body itself; only *insertion* moves to picker.

### Success criteria

- Editing a certificate template in the editor renders the exact same PDF the tenant will receive, live, within 300 ms of a keystroke.
- Publish fails loudly (with the specific missing section named) when statutory completeness or visual QA fails — for both certificates and returns.
- No `Textarea` in the editor accepts a column key, token path, or rule code.
- Returns (P10, PAYE, NSSF, SHIF, Housing Levy, remittance schedules) render through the same section-based renderer as certificates.
- Adding a new country needs only a fixture file + template bodies — zero renderer or editor code change.

### Out of scope

- Multi-language rendering.
- Non-KE packs beyond the fixture proving the platform.
- Editor plugin system for custom section types (v3).
