## What already ships (verified against source)

- `src/design-system/primitives/AuthoringWorkspace.tsx` — IDE-style shell with split / editor-only / preview-only / bottom-dock / focus modes, resizable persisted panels, collapsible outline rail, and shortcuts (⌘S, ⌘B, ⌘⇧P, ⌘⇧F). Now also exposes: `statusBar` slot, `onNavigateNode` (J / K), `onPopOutPreview`.
- Editor-input primitives: `AutoGrowInput`, `AutoGrowTextarea`, `ExpandableTextField`, `CodeField` (mono variant) exported from `@/design-system/primitives/inputs`.
- `CertificateTemplateEditor` is fully migrated: uses `AuthoringWorkspace` with toolbar + outline rail + preview + save footer + live status bar (dirty flag, validation count, node count, shortcut hints) and J / K node walking.
- `CertificateV3Editor` uses `CodeField` / `ExpandableTextField` / `AutoGrowTextarea` throughout.
- `ReturnTemplateEditor` picked up the primitives on its JSON-shaped fields (submission format options, digital-signature / acknowledgement / API-endpoint specs, footnote body) and moved the tenant "Reason for override" textarea to `ExpandableTextField`.

## What is still open

1. `ReturnTemplateEditor` still renders as a single stacked `<Card>` with `PreviewPanel` and `ReturnPreviewPane` inlined mid-form. It never mounts inside `AuthoringWorkspace`, so return-template authoring gets none of the layout modes, keyboard shortcuts, resizable preview, or status bar the certificate editor now has. This is the last gap in the "one authoring workspace" invariant.
2. There is no pop-out preview route, so the `onPopOutPreview` hook the shell exposes is unused. Publishers cannot detach the preview onto a second monitor — the flagship win of the redesign.

## Plan

### 1. Migrate `ReturnTemplateEditor` into `AuthoringWorkspace`

Refactor the render tree so the existing state, handlers, and validation logic are unchanged; only the layout container swaps.

- Split the current single-column body into three slots:
  - `toolbar`: title + mode badge (admin / tenant override) + the "Enable v2 renderer" switch (moved out of the mid-form section so the switch is always reachable).
  - `editor`: the form column — metadata, outputs, filters, columns, group-by, totals, reconciliation, v2 sections list. Wrapped in a `ScrollArea` so long forms scroll independently of the preview.
  - `preview`: a combined preview column that renders `ReturnPreviewPane` when v2 renderer is on, otherwise the existing `PreviewPanel` (default v1). Same data feed as today.
  - `footer`: Cancel / Save buttons (unchanged handlers).
  - `statusBar`: dirty indicator (compare current body+meta+notes JSON to a captured baseline snapshot), validation count (errors + warnings from the existing async validator), column count, and the shortcut hint strip.
- Remove the inline `ReturnPreviewPane` block and the inline `PreviewPanel` from the form body — the preview lives in the workspace's preview pane instead, so it no longer competes for editor width.
- Add `onSave={handleSave}` so ⌘S / Ctrl+S saves from anywhere in the editor.
- Add an outline `rail` listing the top-level sections (Identification, Outputs, Filters, Columns, Group by, Totals, Reconciliation, v2 sections) with click-to-scroll behaviour. Each section gets an `id` and the rail scrolls the editor pane to it.
- Wire J / K to walk between sections (same idea as certificate node navigation but over the section list).
- `workspaceId={\`return-template:${templateCode}\`}` so panel sizes and mode persist per template.

Guard invariants: keep the async `validatePayload` debounced call, keep the tenant-only "Reason for override" section inside the editor pane, keep the `MetadataSection` / `OutputsCard` sub-components untouched.

### 2. Pop-out preview route + hook

Add a real detached-window preview so publishers can drag it to a second display.

- New route: `src/routes/localization.preview.$kind.$templateCode.tsx` (kind = `certificate` | `return`). It is a plain client route that reads the latest draft body from `sessionStorage` (key: `localization-preview:${kind}:${templateCode}`), subscribes to `storage` events for live updates, and renders the appropriate `CertificatePreviewPane` / `ReturnPreviewPane` full-bleed. No auth surface needed — it only reads what the opener just wrote in the same origin.
- Update `CertificateTemplateEditor` and `ReturnTemplateEditor`:
  - Whenever the body changes, `sessionStorage.setItem(key, JSON.stringify({body, meta, ts}))`.
  - Pass `onPopOutPreview={() => window.open('/localization/preview/…', 'localization-preview', 'width=900,height=1200')}` to `AuthoringWorkspace`.
  - When the pop-out window is open, automatically switch the in-editor layout mode to `editor` so the editor immediately expands to full width (restore prior mode when the pop-out closes — tracked via a `beforeunload` message on the child window).
- Add a small "Reopen preview" toast/button behaviour if the child is closed.

### 3. Verification

- `bun run build:dev` (or the project's typecheck) after each of steps 1 and 2 to catch route-tree drift and TS regressions.
- Load `/admin-management/localization-packs/:packId/certificates/:templateId/edit` and the tenant/admin return-template editor via Playwright: assert the workspace toolbar, all five layout mode buttons, ⌘S save handler, J / K navigation, status-bar text, and the pop-out window rendering the preview at the same URL.
- Confirm the runtime `#tanstack-start-entry` error visible in the runtime-errors panel resolves once the new route file lands and the router regenerates (if it does not, that's a separate bootstrap issue and I will restart the dev server after route generation).

## Technical notes

- No schema, RLS, or server-function changes. Everything is presentational.
- No changes to save contracts: `ReturnTemplateEditor.onSave` still receives `{ body, layout, notes, metadata? }`.
- Reuse of primitives only — no new dependencies.
- Persisted keys: `authoring-workspace:return-template:<code>:*`, `localization-preview:<kind>:<code>` (session-scoped).
- Files touched:
  - `src/features/localization/components/ReturnTemplateEditor.tsx` (refactor render tree; keep logic).
  - `src/features/localization/components/CertificateTemplateEditor.tsx` (wire pop-out + sessionStorage broadcast).
  - New: `src/routes/localization.preview.$kind.$templateCode.tsx`.

No item is deferred — both open gaps land in this pass.
