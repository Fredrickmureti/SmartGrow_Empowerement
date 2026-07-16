
# Localization Authoring Workspace — Verification & Finish-Line Plan

## 1. Verification of prior claim ("all 8 editors on AuthoringWorkspace")

Confirmed by inspection:

| Editor | AuthoringWorkspace | Preview pane | Notes |
|---|---|---|---|
| CertificateTemplateEditor | Yes | CertificatePreviewPane | Full-page route (correct pattern) |
| ReturnTemplateEditor | Yes | ReturnPreviewPane | **Still mounted inside a Sheet from `PackEntityTabs` line 619** (user complaint confirmed) |
| BankExportTemplatesEditor | Yes | Spreadsheet | OK |
| GarnishmentsEditor | Yes | Inspector | OK |
| TokenRegistryEditor | Yes | Spreadsheet | OK |
| StatutoryAuthoritiesEditor | Yes | Inspector | OK |
| PackRequirementsEditor | Yes | Inspector | OK |
| PublisherGovernanceEditor | Yes | Inspector | OK |
| **TaxTemplatesEditor** | **No** | none | Reference editor, still bare form |
| **AccountTemplatesEditor** | **No** | none | Reference editor, still bare form |
| **RemittanceSchedulesEditor** | **No** | none | Reference editor, still bare form |
| CertificateV3Editor / TemplateEditor | No | — | Legacy, retained for stored v3 templates only. Leave alone. |

Prior claim ("no items deferred") was **inaccurate**: 3 reference editors were never migrated, and return templates still open inside a drawer instead of a dedicated route.

## 2. Concrete defects to fix

### 2a. Overlay mode constricts the editor
`AuthoringWorkspace.tsx` lines 377–397 render editor as `flex-1 min-w-0` next to a fixed-width preview. As the preview grows the editor shrinks — the exact "seesaw" the overlay mode was supposed to avoid.

Fix: in `overlay` mode, position the preview drawer as `position: absolute; right: 0; top: 0; bottom: 0` inside a relative container, with a subtle backdrop/shadow. Editor keeps its full natural width and the preview truly *slides over* the right edge. Resize handle becomes a left-edge grabber on the drawer. `split` mode keeps the shared-space behavior for users who want it.

### 2b. Preview footer clipped
`LocalizationEntityWorkspace` uses `h-[calc(100vh-14rem)]` which under some shells (topbar + page header + sticky footer) is too tall and the CardContent status strip gets pushed under the page footer. Also the pane shell doesn't reserve room for its footnote row when the pack editor has its own sticky footer.

Fix: replace fixed viewport math with a flex-min-height layout — parent uses `flex-1 min-h-0` and the workspace fills it. Set `flex-shrink-0` on preview status strip and ensure `overflow-hidden` on PaneShell so inner content scrolls, footer stays visible.

### 2c. Return templates still open in a drawer
Certificate templates got a full-page route (`/admin-management/localization-packs/:packId/certificates/:templateId/edit`). Return templates deserve the same treatment.

Fix: add `ReturnEditorPage` route shell in `src/features/localization/routes/`, wire an admin route `/admin-management/localization-packs/:packId/returns/:templateId/edit`, and route the pencil button in `PackEntityTabs` there. Delete the Sheet mount path for returns. Same shape as `CertificateEditorPage`.

### 2d. Reference editors still bare
Wrap Tax / Account / Remittance schedule editors in `LocalizationEntityWorkspace` with a `SpreadsheetPreviewPane` fed by their current row state (columns reflect configured fields; rows show live samples). No behavioral change to CRUD.

### 2e. Preview parity — reflect actual mapped columns
Audit each editor's `preview` prop wiring:
- BankExportTemplatesEditor already binds columns → verify unresolved token flags match validator.
- TokenRegistryEditor: columns should be token_path/source/data_type/description; rows = live registry snapshot.
- Garnishments/StatutoryAuthorities/PackRequirements: currently Inspector — evaluate whether a spreadsheet form is more truthful for the collection-shaped ones (Garnishments and Authorities are lists → switch to `SpreadsheetPreviewPane` showing the row-set the editor will emit). PackRequirements/PublisherGovernance stay Inspector (single-record).

## 3. Implementation phases

**Phase A — Overlay + footer fixes (foundation)**
1. Refit overlay mode in `AuthoringWorkspace.tsx` to a true absolute-positioned drawer with left-edge resize handle, shadow-lg, backdrop opacity, keyboard escape to close.
2. Add `overlayBackdrop` prop (default false in bottom/split, true in overlay) so overlay reads visually as "floating above" editor.
3. Fix `LocalizationEntityWorkspace` height: parent flex; remove `calc(100vh-14rem)`; add container ref that measures available height.
4. Add `min-h-0 overflow-hidden` guarantees inside `PaneShell` and status strip.

**Phase B — Return template full-page route**
1. Create `src/features/localization/routes/ReturnEditorPage.tsx` mirroring `CertificateEditorPage`.
2. Export from `routes/index.ts`.
3. Add TanStack route file `src/routes/admin-management.localization-packs.$packId.returns.$templateId.edit.tsx` (matching the certificate route pattern).
4. Update `PackEntityTabs` pencil handler: for `localization_pack_return_templates` in admin mode, `navigate(...)` — otherwise legacy Sheet stays for tenant.
5. Remove size=full and dead branches once returns take the route.

**Phase C — Reference editors on shared workspace**
1. `TaxTemplatesEditor`: wrap CRUD form in `LocalizationEntityWorkspace` with rail = row list, editor = current form, preview = `SpreadsheetPreviewPane` showing tax bracket rows.
2. `AccountTemplatesEditor`: same shape; preview shows chart-of-accounts mapping grid.
3. `RemittanceSchedulesEditor`: same; preview shows schedule calendar as tabular rows.

**Phase D — Preview parity sweep**
1. GarnishmentsEditor: swap Inspector for Spreadsheet of garnishment kinds (name, cap %, priority, cap type).
2. StatutoryAuthoritiesEditor: Spreadsheet (code, name, jurisdiction, portal_url, contacts count).
3. Verify unresolved-token flags in all Spreadsheet consumers use the same validator path.
4. Add a `mappedColumnsCount` + `unresolvedCount` chip to the preview header — one shared UX contract already in `SpreadsheetPreviewPane`.

**Phase E — Test + doc**
1. Add compile test that every editor under `features/localization/components/*Editor.tsx` (excluding legacy V3) imports `AuthoringWorkspace` or `LocalizationEntityWorkspace`.
2. Update `docs/audit/2026-07-XX-localization-workspace-followup.md` with verification table + fixes.
3. Run `tsgo` and vitest.

## 4. Non-goals
- Not touching `CertificateV3Editor` or legacy `TemplateEditor` — kept for stored v3 payloads until codemod.
- Not changing persistence adapters, RLS, or pack lifecycle.
- Not restyling tokens/theme — pure layout + preview parity.

## 5. Technical details

- Overlay drawer: `absolute inset-y-0 right-0` inside `relative` container; width driven by same `overlayPreviewPx` state; resize handle rendered as left-edge grabber on the drawer (`w-1.5 -translate-x-full`).
- Backdrop uses `bg-background/40 backdrop-blur-[1px]` — non-modal, click-through disabled so editor stays interactive.
- Route file names use TanStack dot-convention: `admin-management.localization-packs.$packId.returns.$templateId.edit.tsx`.
- SpreadsheetPreviewPane rows for reference editors are derived synchronously from the editor's current form state (no server round-trip) — same pattern already used by BankExport.
