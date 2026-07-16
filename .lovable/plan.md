
## Verdict (audit)

Three distinct problems, all rooted in the same architectural gap: the AuthoringWorkspace was built for certificate/return editors only, and its preview slot is a passive pane instead of a first-class, resource-typed surface.

### 1. "Editor shrinks when I drag the preview left"
Current `AuthoringWorkspace` uses a symmetric `ResizablePanelGroup` where editor + preview split 100%. Any drag on the handle reallocates space between them — so pulling the preview wider directly compresses the editor. That is *not* how professional design tools behave. Publishers expect the preview to behave like an **inspector drawer that slides over** the editor, leaving the editor's authoring width stable.

### 2. Preview footer clipped
`PaneShell` wraps preview in `overflow-hidden rounded-lg border`, and the preview panes (`CertificatePreviewPane`, `ReturnPreviewPane`) render a `Card` whose iframe/canvas has a fixed `h-[820px]`. When the workspace also reserves rows for `statusBar` and `footer` at the bottom, the fixed-height inner iframe overflows the available pane and its bottom is scissored — the "Save as PDF" bar and the last document rows never appear.

### 3. Inconsistent preview across other localization editors
Only Certificate and Return editors sit inside `AuthoringWorkspace`. **BankExportTemplatesEditor, GarnishmentsEditor, StatutoryAuthoritiesEditor, TokenRegistryEditor, PackRequirementsEditor, PublisherGovernanceEditor** are still plain forms. Bank exports, garnishment schedules and token registries are inherently **tabular/spreadsheet** artefacts — publishers need to see mapped columns, sample rows, and delimiters live, in an Excel-like grid, not JSON. Right now they publish blind.

---

## Solution

### A. Resize model — "sliding inspector" not "seesaw"

Change the split mode so the editor keeps its authored width and the preview slides in from the right on top of a fixed-width editor rail.

- Add a new mode: `overlay` (the new default when the browser is ≥ 1440px). In `overlay` mode the editor column has a fixed max-width (persisted, default 960px, min 640px); the preview docks into the remaining space and its handle only resizes the **preview**, never the editor.
- Keep the existing `split` mode as an opt-in for users who genuinely want a 50/50 seesaw.
- Add a "Detach preview" pill to the toolbar (uses existing `onPopOutPreview`) surfaced more prominently.
- Persist `mode`, `editor-width`, `preview-width` all under `authoring-workspace:<id>:*`.

### B. Preview pane — remove all fixed heights and enforce fill-parent

- `PaneShell` keeps `overflow-hidden` on its outer border but becomes a **flex column** so its child stretches to `100%` height.
- `CertificatePreviewPane`, `ReturnPreviewPane`, and the new grid preview render `Card` with `h-full flex flex-col`, `CardContent flex-1 min-h-0`, and the iframe/canvas becomes `h-full w-full` (no `h-[820px]`).
- Move the "Save as PDF" bar into the pane's `CardHeader` (already done for cert) so it is always visible above the scroll region — never in a footer that competes with the workspace's own footer.
- Add a bottom safe-area gutter (`pb-2`) inside `PaneShell` when the workspace also has a `footer`, so the preview's last row never sits flush against the save-bar shadow.

### C. Universal preview contract for every localization editor

Introduce a shared preview taxonomy in `src/features/localization/lib/preview/`:

```
PreviewKind = "certificate" | "return" | "bank-export"
            | "garnishment-schedule" | "token-registry"
            | "statutory-authority" | "pack-requirements"
            | "publisher-governance"
```

Each editor exports a `renderPreview(payload) → ReactNode` that reads the same live draft the form owns, and the shared `LocalizationPreviewShell` picks the correct pane. `previewBroadcast` already keys on `(kind, code)` — extend the kind union.

Standardize on three visual pane types:

| Pane                    | Used by                                              | Renderer                        |
| ----------------------- | ---------------------------------------------------- | ------------------------------- |
| `PagedDocumentPane`     | Certificate, Return (v1 & v2)                        | existing paged.js / pdf-lib     |
| `SpreadsheetPreviewPane`| Bank export, Garnishment schedule, Token registry    | new virtualised grid            |
| `EntityInspectorPane`   | Statutory authority, Pack requirements, Governance   | key/value + relationship graph  |

`SpreadsheetPreviewPane` is the "enterprise-grade Excel preview" the user asked for:

- Renders columns exactly as the `spec` maps them (CSV column order, fixed-width offsets rendered as monospaced columns with ruler, ISO20022 shown as a collapsible tree).
- Injects a synthetic KE payroll fixture (reuse `KE_RETURN_PREVIEW_PAYLOAD`) so publishers see 20 sample rows populated with the tokens they wired up.
- Header row shows the token binding under each column name (`employee.bank_account_number`) and flags unresolved tokens in red — same UX contract as the certificate v3 renderer surfacing unresolved bindings.
- Status strip below the grid shows delimiter, encoding, line count, byte size, and validation warnings.
- Uses `@tanstack/react-table` (already in the project) + `react-window` for virtualisation; no new heavyweight grid library.

### D. Migrate remaining editors into `AuthoringWorkspace`

For each of Bank export / Garnishments / Statutory authorities / Token registry / Pack requirements / Publisher governance:

1. Wrap the existing form list + drawer as the `editor` slot.
2. Add `rail` = entity list (already exists as an inline list in most — extract it).
3. Add `preview` = the appropriate pane from the taxonomy above.
4. Add `statusBar` = dirty flag, validation count, entity count, shortcut hints (same pattern as CertificateTemplateEditor).
5. Wire `workspaceId = "<kind>:<packId>:<entityCode>"` for per-record persistence.
6. Wire `onPopOutPreview` via `publishPreview` + `openPreviewWindow`.
7. Register the new kind in `LocalizationPreviewWindow` so the pop-out route mounts the right pane.

### E. Pop-out route parity

`localization.preview.$kind.$templateCode.tsx` already accepts `$kind` — extend the switch to the new kinds and lazy-load the correct pane component.

---

## Technical details

### Files to add
- `src/design-system/primitives/AuthoringWorkspace.tsx` — add `overlay` mode; new `editorMaxWidth` prop; adjust keyboard shortcut docstring.
- `src/features/localization/components/preview/SpreadsheetPreviewPane.tsx` — new.
- `src/features/localization/components/preview/EntityInspectorPane.tsx` — new.
- `src/features/localization/components/preview/PagedDocumentPane.tsx` — thin wrapper re-exporting the existing certificate/return panes under a common interface.
- `src/features/localization/lib/preview/registry.ts` — `PreviewKind` union, `resolvePreview(kind, payload)` helper, shared fixtures.
- `src/features/localization/lib/fixtures/bankExportFixture.ts` and `garnishmentFixture.ts` — synthetic sample rows.

### Files to edit
- `src/features/localization/components/BankExportTemplatesEditor.tsx` → migrate into AuthoringWorkspace + SpreadsheetPreviewPane.
- `src/features/localization/components/GarnishmentsEditor.tsx` → migrate + SpreadsheetPreviewPane.
- `src/features/localization/components/TokenRegistryEditor.tsx` → migrate + SpreadsheetPreviewPane.
- `src/features/localization/components/StatutoryAuthoritiesEditor.tsx` → migrate + EntityInspectorPane.
- `src/features/localization/components/PackRequirementsEditor.tsx` → migrate + EntityInspectorPane.
- `src/features/localization/components/PublisherGovernanceEditor.tsx` → migrate + EntityInspectorPane.
- `src/features/localization/components/CertificatePreviewPane.tsx` → drop fixed heights, `h-full` iframe, remove bottom clip.
- `src/features/localization/components/ReturnPreviewPane.tsx` → same; remove `h-[820px]`.
- `src/features/localization/components/LocalizationPreviewWindow.tsx` → dispatch on extended `PreviewKind` union.
- `src/routes/localization.preview.$kind.$templateCode.tsx` → allow the new kind values through the param.
- `src/features/localization/lib/previewBroadcast.ts` → widen `PreviewKind`.

### No changes
- No SQL migrations. No RLS or grants. No edge-function changes. Existing renderers (`compile()` for cert, `renderReturnPdf` for return) remain the source of truth for what will actually be filed.

### Verification
- `bun run build:dev` after each editor migration.
- Playwright script that opens each of the six editors, screenshots the split, drags the preview handle, and asserts the editor's bounding-box width is unchanged in `overlay` mode.
- Playwright asserts the preview's last row and its "Save as PDF" affordance are within the visible viewport (no clipping) when both status bar and footer are present.

No deferred items — resize model, footer clipping, and preview standardisation across all six remaining editors all land in this pass.
