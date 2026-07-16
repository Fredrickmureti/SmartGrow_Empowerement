# Localization Preview Consolidation — Resume & Finish

## Verification of prior agent's work

**Phase A — Partially done**
- ✅ Legacy `TemplateEditor.tsx` deleted; export removed from `src/features/localization/index.ts`.
- ❌ Tenant return override still opens inline in `WorkflowSheet` at `src/pages/hr/payroll/Templates.tsx` (lines 187–269). Must route through `ReturnEditorPage` like certificates already do.
- ❌ "Section-based renderer (v2)" toggle + section vocabulary UI still present in `ReturnTemplateEditor.tsx` (lines 143, 226, 689–697, 831). Must be retired as part of Phase C, but the misleading toolbar toggle and label should be replaced immediately with a read-only "PDF layout" section shown only when the primary output is `pdf`.

**Phase B — Done**
- ✅ `lib/preview/rendererRegistry.tsx` with `resolveReturnRenderer` + `resolvePopOutRenderer` + `describeReturnFormat`.
- ✅ `lib/preview/samplePayload.ts` (country-agnostic).
- ✅ `components/preview/SerialisedPayloadPreview.tsx` extracted.
- ✅ `ReturnFormatPreview` and `LocalizationPreviewWindow` delegate to the registry.
- Gap: no unit tests for the registry yet (plan §4 Phase B calls them out).

**Phases C–F — Not started.** `keReturnFixture` still imported by `ReturnPreviewPane` and `BankExportTemplatesEditor`. `renderer: "v2-returns"` still a live code path. No ESLint guardrails. No pop-out coverage for the other 6 editor tabs.

## Work to complete (no deferrals)

### 1. Finish Phase A
- Add a tenant route `PayrollReturnTemplateEdit` that mounts `ReturnEditorPage` with an override persistence adapter (mirror `PayrollCertificateTemplateEdit`).
- In `pages/hr/payroll/Templates.tsx`: for `kind === "return"` rows, `navigate()` to the new tenant edit route instead of opening `WorkflowSheet`. Remove the return branch from `OverrideEditor`; keep the sheet only for non-editor entities if any remain (otherwise delete `OverrideEditor` entirely and the `WorkflowSheet` import).
- Rewrite the v2 toolbar in `ReturnTemplateEditor.tsx`: replace the toggle with a computed, read-only "PDF layout" panel that appears **only** when `resolvePrimaryOutput(meta).format === "pdf"`. Copy: "This return is filed as a PDF. Section vocabulary defines page layout." No user-facing "v2" label.

### 2. Phase C — Retire pdf-lib and `v2-returns` (data + code migration in one PR)
- Introduce return AST reusing certificate v3 primitives (`grid`, `field_row`, `columns`, `label_fill`, `page_break`). Add `schema_version: 1` to `ReturnBody` alongside a `nodes: Node[]` field.
- Add `compileReturn()` that wraps `lib/engine/compile.ts` with a return-flavoured theme; render via a shared `PagedHtmlSurface` (rename from `CertificateHtmlSurface`; keep re-export shim for one release).
- New `ReturnHtmlSurface` (thin wrapper) replaces `ReturnPreviewPane`; registry `return/pdf` case switches to it.
- Data migration `supabase/migrations/…_migrate_v2_returns_to_ast.sql`: for every `payroll_return_template` where `body->>'renderer' = 'v2-returns'`, transform each `sections[]` element into the equivalent AST node (`field_row` for identity strip, `grid` for tabular sections), write to `body.nodes`, drop `renderer` and `sections`. Assert row count parity before commit.
- Delete: `lib/pdf/returnRenderer.ts`, `supabase/functions/_shared/pdf/returnRenderer.ts`, `lib/fixtures/keReturnFixture.ts`, `components/ReturnPreviewPane.tsx`, `renderer` + `sections` fields from `ReturnBody` type.
- Update `BankExportTemplatesEditor.tsx` (3 sites) to use `SAMPLE_PAYROLL_ROWS` from `samplePayload.ts`.
- Byte-parity test extending `certificate-engine.mirror-parity.test.ts` for the return fixture.

### 3. Phase B follow-up — unit tests for registry
- `resolveReturnRenderer.test.ts`: one case per formatKind (csv/xlsx/xml/json/pdf) asserting descriptor id + component identity.
- `resolvePopOutRenderer.test.ts`: one case per `PreviewKind`, including the "invalid kind" empty state.

### 4. Phase D — Broadcast coverage + lifecycle
- Wire `publishPreview()` in: `BankExportTemplatesEditor`, `GarnishmentsEditor`, `TokenRegistryEditor`, `StatutoryAuthoritiesEditor`, `PackRequirementsEditor`, `PublisherGovernanceEditor`. Use the entity's canonical code as `templateCode`.
- Add `clearPreview(kind, templateCode)` to `previewBroadcast.ts`; call on editor unmount.
- Add `heartbeat` message in the broadcast writer (every 5s); pop-out shows "Editor closed" if no heartbeat for 15s.
- Show the "Pop out preview" button on every tab whose editor publishes.

### 5. Phase E — Guardrails + docs
- ESLint rule `eslint-rules/no-pdf-lib-in-localization-preview.js`: forbid `pdf-lib` import under `src/features/localization/` and `supabase/functions/_shared/certificate-engine/`.
- ESLint rule `eslint-rules/no-country-fixture-in-shared-preview.js`: forbid `ke*Fixture` / country-prefixed fixture imports under `components/preview/**` and `lib/preview/**`.
- Wire both rules into `.eslintrc` and add a test file per rule under `eslint-rules/__tests__/`.
- Architecture test: extend `src/__tests__/architecture.fiscal-country-agnostic.test.ts` to assert no country token appears in `lib/preview/**` or `components/preview/**`.
- ADR `docs/adr/0063-localization-preview-renderer-registry.md` documenting the target architecture, renderer dispatch rule, and retirement of `v2-returns`.
- Update `mem://features/certificate-rendering` → rename memory to `localization-rendering` and note returns share the pipeline. Add Core rule: "Localization previews resolve through `resolveRenderer`; no ad-hoc switches. pdf-lib is forbidden in localization code."

### 6. Phase F — Enterprise polish
- "Format not declared" empty state in `ReturnFormatPreview` with a button that focuses `OutputsCard`.
- Multi-output tabs: when `meta.outputs.length > 1`, render a `<Tabs>` above the preview, one entry per output; renderer picked via registry per tab.
- Persist selected output tab per `(persona, kind, templateCode)` in `localStorage` under `lz.preview.tab.<hash>`.

## Order of execution

1. Phase A finish (routes + toolbar rewrite) — smallest, unblocks tenant-return parity.
2. Registry unit tests (Phase B follow-up).
3. Phase C — data migration + AST + delete pdf-lib pipeline (largest single PR-equivalent).
4. Phase D — broadcast coverage.
5. Phase E — guardrails + ADR + memory.
6. Phase F — polish.

Each step ends with `bunx vitest run` on the touched suites plus `tsgo` on the touched files; the Phase C step additionally runs the mirror-parity and architecture suites.

## Technical notes

- `PagedHtmlSurface` rename keeps a `CertificateHtmlSurface` re-export until every import migrates in the same PR to avoid a two-step deprecation.
- The migration SQL must be idempotent (`WHERE body ? 'renderer'`) and paired with a `pack_audit_log` row per row rewritten so publishers can trace it.
- Broadcast heartbeat uses the same `BroadcastChannel`; no new transport.
- New ESLint rules follow the existing pattern in `eslint-rules/no-payslip-lines-in-certificates.js`.
