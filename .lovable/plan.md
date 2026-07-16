
# Localization Preview & Publishing — Architectural Audit + Consolidation Plan

## 1. Architecture as it stands today

### 1.1 Editor shells (who mounts what)

| Persona | Certificate template | Return template |
|---|---|---|
| Platform Admin (pack editor) | `PackEntityTabs` → routes to `AdminLocalizationCertificateEdit` → `CertificateEditorPage` → `CertificateTemplateEditor` (v3 AST + `AuthoringWorkspace`) | `AdminLocalizationReturnEdit` → `ReturnEditorPage` → `ReturnTemplateEditor` (`AuthoringWorkspace`) |
| Platform Admin (all other pack entities) | — | `PackEntityTabs` mounts `GarnishmentsEditor`, `BankExportTemplatesEditor`, `TokenRegistryEditor`, `StatutoryAuthoritiesEditor`, `PackRequirementsEditor`, `PublisherGovernanceEditor` inline (no `AuthoringWorkspace`, no shared shell) |
| Tenant — certificate | `pages/hr/payroll/Templates.tsx` **navigates** to `PayrollCertificateTemplateEdit` → same `CertificateEditorPage` → `CertificateTemplateEditor` ✅ shared | `pages/hr/payroll/Templates.tsx` opens `WorkflowSheet` and mounts `ReturnTemplateEditor` **inline** — NOT `ReturnEditorPage`. Divergent shell (dialog vs. full page), no pop-out preview from that entry point in practice, different visual chrome. |

**Duplicate editor pipeline still exported and reachable:** `src/features/localization/components/TemplateEditor.tsx` (block-based, 481 lines). It is imported by `pages/hr/payroll/Templates.tsx` in the `else` arm of `kind === "return"`. Because the tenant certificate row `navigate`s away before that arm mounts, `TemplateEditor` is functionally **dead code** — but it is still exported from `src/features/localization/index.ts`, still validated, still shipped in the bundle. It represents an obsolete authoring model (named text blocks with `TokenAwareTextarea`) that was superseded by the certificate v3 AST editor.

### 1.2 Preview panes

| Pane | Used by | Renders via |
|---|---|---|
| `CertificatePreviewPane` → `CertificateHtmlSurface` | Certificate editor (both personas), pop-out `certificate` | v3 AST → `compile()` → **HTML + paged.js in iframe** (the modern, memory-blessed path) |
| `ReturnPreviewPane` | Return editor when `body.renderer === "v2-returns"`, pop-out `return` when v2 | **pdf-lib** direct drawing (`lib/pdf/returnRenderer.ts`) fed a KE-specific fixture (`KE_RETURN_PREVIEW_PAYLOAD`, `buildPreviewReturnTemplate` — imports `keReturnFixture.ts`) |
| `PreviewPanel` | Non-v2 fallback inside `ReturnFormatPreview` for `kind==="pdf"`; also mounted by the legacy `TemplateEditor` | Tabular HTML approximation of a PDF |
| `SpreadsheetPreviewPane` | `ReturnFormatPreview` (csv/xlsx branch), and the pop-out for `bank-export` / `token-registry` / `garnishment` | Excel-like HTML grid |
| `EntityInspectorPane` | Pop-out only, for `statutory-authority` / `pack-requirements` / `publisher-governance` | Read-only property list |
| `ReturnFormatPreview` | Return editor (both personas via `previewPane`), pop-out `return` | Dispatcher: routes by `meta.submission_format.kind` → spreadsheet / xml / json / pdf |

### 1.3 Detached preview + live sync

- `previewBroadcast.ts` (BroadcastChannel + `localStorage` mirror, keyed by `kind:templateCode`) is a genuinely shared transport.
- `/localization/preview/$kind/$templateCode` route → `LocalizationPreviewWindow` → `PopOutBody` switch by `kind`. This switch is the **single renderer-selection point** in the pop-out.
- Only `certificate` and `return` editors currently `publishPreview()`. The other kinds listed in `PreviewKind` (`bank-export`, `garnishment`, `token-registry`, `statutory-authority`, `pack-requirements`, `publisher-governance`) are declared but no editor publishes them — the pop-out button is not wired for those tabs.
- No editor unmounts cleanly: pop-out payload lives forever in `localStorage`; closing the editor and reopening a different template can flash stale content before the first `publishPreview` fires.

### 1.4 Renderer selection (the real logic today)

The **only** context-aware dispatch lives in `preview/ReturnFormatPreview.tsx`:

```
declared = meta.submission_format.kind
hasV2    = body.renderer === "v2-returns"
kind     = declared ?? (hasV2 ? "pdf" : "csv")
```

Everything else is hard-wired: certificate → HTML/paged.js; anything the pop-out doesn't recognise → empty state. There is no `Renderer` interface — the dispatch is an ad-hoc `switch`/`if` at every consumer.

## 2. Problems the audit surfaced

1. **Renderer-first UI, not content-aware.** `ReturnTemplateEditor` shows a permanent **“Section-based renderer (v2) — the PDF is drawn from the section vocabulary below”** section AND a toolbar toggle regardless of whether the artefact is a CSV/XLSX/JSON/XML upload. For KE `P10 (iTax CSV)`, whose `submission_format.kind = "csv"`, the toggle is meaningless — enabling it forces a PDF preview of something the runtime will never emit as PDF. The label itself misleads the publisher.
2. **`renderer: "v2-returns"` is a private, legacy flag.** It predates the `format_registry`/`OutputsCard`/`submission_format.kind` triple. Today it is a second, orthogonal switch that only makes sense for one narrow slice of returns (paper-filed PDF returns like NSSF paper form). It should be replaced by a declared `pdf` output whose renderer is auto-selected — not exposed as a UX-level toggle.
3. **Two rendering technologies for the same class of artefact.** Certificates are rendered via HTML + paged.js (v3 engine, single source of truth, memory-enshrined constraint). Returns still render via pdf-lib direct drawing — the exact "bad design" the certificate memory forbids ("do NOT rebuild… pdf-lib hand-drawn cells"). The return-PDF path is the last surviving instance of the retired pattern.
4. **Country-agnostic invariant violated in the return preview.** `lib/fixtures/keReturnFixture.ts` and `KE_RETURN_PREVIEW_PAYLOAD` bake Kenya-specific PINs, statute names, and rule codes into the shared preview pipeline. A Ghana or SA publisher previewing their own return sees KE data.
5. **Editor shell divergence for the same asset type.** Tenant return override opens in a `WorkflowSheet` (2xl dialog) with different chrome, no `AuthoringWorkspace` behaviour, no keyboard shortcuts, no pop-out affordance in practice. Admin returns open full-viewport. Same editor, different shell → different mental model. Certificate tenant path was migrated (both use `CertificateEditorPage`); return tenant path was not.
6. **Dead / duplicate authoring pipeline still exported.** `TemplateEditor` (block-based) is unreachable via UI but still exported, imported, and included in the bundle — an obsolete "third editor" for anyone who spelunks the exports.
7. **Renderer dispatch is scattered.** `ReturnFormatPreview` dispatches by `submission_format.kind`; `PopOutBody` dispatches by `PreviewKind`; `CertificatePreviewPane` hard-selects HTML. There is no single `resolveRenderer(kind, metadata, body)` function anyone can extend for a new artefact (e.g., ISO 20022 pain.001, EDIFACT, FIX).
8. **Pop-out coverage is uneven.** Broadcast wiring exists for 8 kinds, but only 2 editors ever publish. For the other tabs the pop-out button either isn't shown, or opens a permanently empty pop-out.
9. **Preview fixtures live per-editor.** `PreviewPanel` has its own `SYNTHETIC_CTX`, `ReturnFormatPreview` has its own `SAMPLE_ROWS`, `ReturnPreviewPane` uses `KE_RETURN_PREVIEW_PAYLOAD`. Three sources of "sample payroll data" that drift independently and one of which is country-locked.
10. **Section-based renderer (v2) status.** It is **partially migrated / superseded** — it was the pre-metadata mechanism to get a PDF out of a return template before `submission_format.kind` and the `format_registry` existed. Its remaining valid use case (declaring the section vocabulary for a legitimately-PDF paper return) can be modelled cleanly as a `pdf` output whose body carries `sections[]`. There is no reason to keep the toggle or the "v2" label — retire.

## 3. Renderer-selection strategy (target)

Introduce a small, extensible dispatcher shared by both the split-pane preview and the pop-out:

```text
Editor state ─┐
Template meta ─┼─▶ resolveRenderer({artefact, formatKind, body}) ─▶ Renderer descriptor
Pack metadata ─┘                                                       │
                                                                       ▼
                                                            <PreviewSurface renderer=...>
```

- **Renderer registry**: `src/features/localization/lib/preview/rendererRegistry.ts` exports a typed `Renderer<Body, Meta>` shape with `{ id, artefact, formatKinds, matches(meta, body), Component }`.
- **Dispatch rule (deterministic, no fallback guessing)**:
  1. `meta.outputs[]` (`OutputsCard`) is the ground truth for what the runtime will emit. The **primary output** (`role_hint === "human_readable"` else first) drives the preview.
  2. If `outputs` is empty (legacy row), fall back to `meta.submission_format.kind` (returns) or the artefact's implicit type (certificates → pdf).
  3. Renderer for `(artefact, formatKind)` is looked up in the registry. Missing entry → an explicit "no preview available for `<format>`" surface with a link to declare an output.
- **Renderers registered day 1**:
  - `certificate/pdf` → `CertificateHtmlSurface` (paged.js, unchanged)
  - `return/csv` and `return/xlsx` → `SpreadsheetPreviewPane`
  - `return/xml` and `return/json` → new `SerialisedPayloadPreview` (extract the current inline `XmlJsonPreview` into its own file)
  - `return/pdf` → **new** `ReturnHtmlSurface` sharing the certificate compile pipeline (see Phase C), replacing `ReturnPreviewPane` + pdf-lib
  - `bank-export`, `garnishment`, `token-registry` → `SpreadsheetPreviewPane`
  - `statutory-authority`, `pack-requirements`, `publisher-governance` → `EntityInspectorPane`
- The pop-out window and the split-pane preview both consume `resolveRenderer(...)` — one dispatch, one truth.

## 4. UX inconsistencies to correct

- Return editor exposes a permanent "Section-based renderer (v2)" section and a toolbar toggle even when the output is CSV/XML/JSON — retire.
- Tenant return override opens in a dialog; admin opens full-viewport → unify on `ReturnEditorPage` navigation.
- Preview header ("Live preview" chip) does not communicate the output kind — always show `Format: CSV · UTF-8 · comma-delimited` / `PDF · A4 landscape` / `XML payload — iTax schema v3` so the publisher's mental model matches reality.
- Pop-out button visible on tabs that don't publish — hide until a broadcaster exists.
- Pop-out shows stale template data on cross-template navigation — clear on unmount.
- Three separate synthetic payload sources ("Jane Doe" here, "Alice" there, KE-only fixture elsewhere) — consolidate.

## 5. Phased plan

### Phase A — Kill the misleading UX (surface-level, no runtime change)
- Remove the "Section-based renderer (v2)" toolbar toggle and editor section from `ReturnTemplateEditor` when `submission_format.kind !== "pdf"` (i.e., show it only when the declared output is PDF and rename to "PDF section layout").
- Add a Format header strip to every preview pane (`Format: <label> · <options>`), derived from the declared output.
- Hide the pop-out button on editors whose kind has no broadcaster yet.
- Delete the exported but unreachable `TemplateEditor` (block-based) and its export from `src/features/localization/index.ts`. Remove the `else` arm in `pages/hr/payroll/Templates.tsx`.
- Route the tenant return "Override" click through the full-page `ReturnEditorPage` (mirror what certificates already do). Delete the inline `WorkflowSheet` `OverrideEditor` return branch.

### Phase B — Extract the renderer registry
- Create `lib/preview/rendererRegistry.ts` and `lib/preview/resolveRenderer.ts`.
- Move `ReturnFormatPreview` dispatch logic into the registry.
- Move `LocalizationPreviewWindow`'s `PopOutBody` switch into the registry.
- Extract inline `XmlJsonPreview` from `ReturnFormatPreview.tsx` into `preview/SerialisedPayloadPreview.tsx`.
- Consolidate synthetic sample payloads into `lib/preview/samplePayload.ts` (country-agnostic; pack tokens layer via `pack_token_registry.sample_value`).
- Add unit tests for `resolveRenderer` covering every registered pair.

### Phase C — Retire pdf-lib from returns (align with certificate memory)
- Introduce a return document AST (`schema_version: 1` for returns) or reuse the certificate v3 primitives (`grid`, `field_row`, `columns`, `label_fill`, `page_break`) — the certificate engine is explicitly country-agnostic and already supports statutory-form layouts.
- Compile via the same `compile()` pipeline in `lib/engine/compile.ts`, render via `CertificateHtmlSurface` (rename to `PagedHtmlSurface` and share).
- Migrate the seven KE return templates that opt into `v2-returns` to the new AST via a data migration. Drop `body.renderer === "v2-returns"` support paths.
- Delete `lib/pdf/returnRenderer.ts`, `supabase/functions/_shared/pdf/returnRenderer.ts`, `lib/fixtures/keReturnFixture.ts`, and `ReturnPreviewPane`. Server-side PDF for returns joins the same Phase D (Cloudflare Browser Rendering) work already planned for certificates.
- Remove the `renderer` and `sections` fields from `ReturnBody`. `outputs[]` + AST are the single source of truth.

### Phase D — Broaden pop-out and preview coverage
- Wire `publishPreview` from `BankExportTemplatesEditor`, `GarnishmentsEditor`, `TokenRegistryEditor`, `StatutoryAuthoritiesEditor`, `PackRequirementsEditor`, `PublisherGovernanceEditor` so the pop-out affordance is honest across every tab.
- Add "clear on unmount" to the broadcast writer to prevent stale preview flashes.
- Add a `subscribePreview` heartbeat so the pop-out can display "Editor closed" when the parent goes away.

### Phase E — Governance & guardrails
- ESLint rule (mirroring `no-payslip-lines-in-certificates`) `no-pdf-lib-in-localization-preview`: forbid `import "pdf-lib"` under `src/features/localization/`. Prevents regression to hand-drawn PDFs.
- ESLint rule `no-country-fixture-in-shared-preview`: forbid `ke*Fixture` / country-token imports from `components/preview/**` and `lib/preview/**`.
- Architecture test extending `certificate-engine.compile.test.ts` to cover the return AST.
- Document the target in `docs/adr/00xx-localization-preview-renderer-registry.md` and update `mem://features/certificate-rendering` to encompass returns.

### Phase F — Enterprise polish
- Add a "Format not declared" empty state to the preview (with one-click "Add output…" that scrolls to `OutputsCard`).
- Multi-output previews: when `outputs[]` contains more than one entry (e.g., `csv` + `pdf`), show a tabbed preview so publishers can inspect every artefact the runtime will emit.
- Persist the last-selected output tab per (persona, templateCode) in `localStorage`.

## 6. Non-goals (explicit)

- No changes to `pack_token_registry`, `format_registry`, or edge-function signatures beyond removing the retired `renderer: "v2-returns"` path.
- No new server-side PDF work — Phase D (server PDF) remains the existing separate initiative and lands after Phase C.
- No visual redesign of the `AuthoringWorkspace` shell itself — the shell is already the correct abstraction; the fix is what mounts inside it and how the preview is chosen.

## 7. Deliverables (in order)

1. This audit (delivered).
2. Phase A PR (UX truth + dead-code cleanup + tenant return route unification).
3. Phase B PR (renderer registry + dispatcher tests).
4. Phase C PRs, split by return template family (KE PAYE first, then contributions, then reconciliations).
5. Phase D PR (broadcaster coverage + lifecycle hardening).
6. Phase E PR (guardrails + ADR + memory update).
7. Phase F PR (multi-output tabs + polish).

Only Phase A touches user-visible UX in a way publishers will notice immediately; the rest is invisible-by-design consolidation that keeps the preview looking identical while collapsing the underlying architecture to one path per artefact type.
