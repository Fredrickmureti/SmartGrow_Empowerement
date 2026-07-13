
# Document Publishing Platform — Audit + Phase 1

## Part 1 — Architectural Audit (verdict)

### What is already right (keep)
- **Country-agnostic AST + HTML/CSS engine** (`src/features/localization/lib/engine/`, mirrored to `supabase/functions/_shared/certificate-engine/`). This is the correct enterprise model: templates are data owned by localization packs; the engine knows only generic primitives (grid, list, label_fill, field_row, columns, rich_text, heading, page_break, signature_strip). Enforced by tests scanning for country tokens.
- **Paged.js rendering in an isolated iframe** — preview equals filed output by construction. This is the same approach mature ERPs use (SAP Adobe Forms, Oracle BI Publisher, Odoo's QWeb+wkhtmltopdf all converge on "HTML/XSL-FO template → paginated renderer").
- **Pack-owned Theme tokens** driving CSS custom properties. Presentation belongs to the pack, not the engine.
- **v3 → v4 primitive enlargement** (grid with colspan/rowspan/footer sum_of, nested lists, label_fill, field_row, columns) — the primitive set is now expressive enough for real statutory forms.
- **The prior rebuild away from pdf-lib hand-drawing** was correct and must not be undone.

### What is architecturally wrong (fix)
1. **The editor is a drawer of forms, not a document studio.** Structural authoring, theme, metadata, bindings, mappings, outputs, and validation are all crammed into a side panel. This is the single biggest gap versus SAP/Oracle/Odoo report designers.
2. **The canvas is read-only.** Publishers must round-trip through the inspector for every change — the exact opposite of how Word/InDesign/Adobe LiveCycle/Oracle BI Publisher's Layout Editor work. There is no selection model in the canvas, no click-to-edit, no drag-to-reorder, no in-canvas resize.
3. **No canonical selection/command model.** GridDesigner has its own cell-selection state; the outline tree has its own node selection; the canvas has none. There is no single `selection` + `dispatch(command)` reducer, so future features (undo/redo, multi-select, collaborative editing, keyboard shortcuts) have nowhere to hook in.
4. **No server-side PDF (Phase D still deferred).** Today "PDF" only exists if a human hits browser Print. Email dispatch, bulk export, and e-filing cannot work. The `text/plain` HTML workaround in `generate-tax-certificate` is a smell.
5. **Entry point is a route to a drawer, not a workspace.** Versioning, publish, diff, preview, health, and edit are scattered — not a first-class workflow like invoice creation.
6. **Bindings are edited as raw `path` strings** in most inspectors — no token picker in context, no validation of the path against the pack's token registry at edit time. TokenPicker exists but isn't wired into per-node editors uniformly.

### What Phase 1 changes
Replace the drawer editor with a full-page **Template Studio** built around a true WYSIWYG canvas and a canonical selection/command model. Keep the AST, engine, paged.js preview, and pack registry unchanged — this is a UX/editor-architecture rewrite, not an engine rewrite.

Later phases (out of scope for this session, tracked in the roadmap section):
- **Phase 2:** Unify `field_row` / `label_fill` / ad-hoc field editors into one `field` primitive with a single inspector.
- **Phase 3:** Server-side PDF via Cloudflare Browser Rendering binding (Phase D of the prior plan), replacing the `text/plain` workaround.
- **Phase 4:** Promote every localization asset (rules, tax templates, remittance schedules, return templates) from drawers to workspaces with the same shell.
- **Phase 5:** Collaborative editing / comments / review workflow on templates (Odoo Studio parity).

---

## Part 2 — Phase 1: Template Studio (this session)

### Route + shell
- New file-based route: `src/routes/_authenticated/localization/templates/$templateId.tsx` — full page, own head(), auth-gated (safe under `_authenticated`).
- Three-pane layout, no drawer:
  - **Left rail (280px, collapsible):** document outline (tree of AST nodes) + template metadata section (code, pack, version, status).
  - **Center (fluid):** the WYSIWYG canvas — paged.js preview rendered into an iframe, overlaid with an interaction layer (see "Canvas interaction model" below).
  - **Right inspector (360px, collapsible):** context-sensitive editor for the current selection. When nothing is selected → Theme + Paper editor. When a node is selected → that node's inspector (grid → GridDesigner, list → list inspector, etc. — reuse existing inspector components verbatim).
- **Top bar:** template name, status badge, version selector, `Preview`, `Validate`, `Save draft`, `Publish version`, `Diff vs published`, overflow menu (Duplicate, Export JSON, Import JSON, History).
- **Bottom status bar:** validation summary (errors/warnings count from `validateV3Body`), zoom control, page indicator.
- Existing drawer entry points across the localization module redirect to the new route (one changed entry, all callers follow).

### Canvas interaction model (the WYSIWYG core)
The canvas is the single source of interaction; the inspector reflects and refines.

- **Selection layer:** an absolutely-positioned overlay `<div>` on top of the paged.js iframe. On every render, the compiler already emits `data-ce-node="doc.<idx>"` / `data-ce-type` markers. A `postMessage` bridge inside the iframe reports bounding rects for every marked node up to the parent, which draws selection boxes and hit targets in the overlay. This is the only new engine-adjacent code; the compiler itself does not change.
- **Click → select:** clicking anywhere in the canvas resolves to the deepest node under the cursor, sets `selection = { path }`, and scrolls the inspector to that node's editor. Shift-click extends selection (siblings only, Phase 1 scope).
- **Direct text editing:** for text-bearing nodes (`heading`, `rich_text`, `label_fill.label` literals, cell literals), double-click enters edit mode. The overlay renders a `contentEditable` proxy positioned over the rendered text; commits dispatch a `SetLiteral` command. Bindings (`{ kind: "binding", path }`) are shown as chips and edited via the inline TokenPicker popover, never as raw strings.
- **Drag-to-reorder:** document-level nodes and list/columns children get drag handles in the overlay. Drop dispatches `MoveNode({ from, to })`.
- **In-canvas structural ops:**
  - Grid: column-width drag handles rendered on top of the grid's `<colgroup>` widths; cell click selects the cell; a floating mini-toolbar (Merge →, Split →, Merge ↓, Split ↓, Σ) appears above the selected cell. GridDesigner's logic moves into shared command handlers so both the canvas toolbar and the inspector-side spreadsheet call the same commands.
  - Insert bar: a `+` gutter between block-level nodes opens a palette (Heading / Paragraph / Grid / List / Field row / Label fill / Columns / Page break / Image / Signature).
- **Keyboard:** arrows navigate siblings, `Enter` edits, `Esc` exits edit, `Delete` removes node (with confirmation for grids/lists), `Cmd+Z / Cmd+Shift+Z` undo/redo.
- **Zoom + page navigation:** overlay stays aligned by re-measuring on iframe `resize` and on paged.js `rendered` event.

### State + command model (the missing canonical layer)
- New module `src/features/localization/studio/state.ts` exposes a Zustand store:
  - `document: DocumentBody` (the v3/v4 AST)
  - `selection: { path: NodePath | null; cellRange?: GridRange }`
  - `history: { past: Patch[]; future: Patch[] }`
  - `dirty: boolean`, `validation: ValidationResult`
- All mutations go through `dispatch(command)`. Command set for Phase 1:
  - `SetLiteral`, `SetBinding`, `InsertNode`, `RemoveNode`, `MoveNode`, `UpdateNodeProps`
  - Grid-specific: `SelectCell`, `MergeCells`, `SplitCell`, `ToggleSumOf`, `ResizeColumn`, `AddHeaderRow`, `AddFooterRow`, `AddDataRow`
  - Theme: `UpdateTheme`, `UpdatePaperFormat`
- Every command returns an immer patch → drives undo/redo cheaply and makes future collaborative editing (Yjs) a drop-in.
- The canvas overlay, the outline tree, GridDesigner, and per-node inspectors all read `selection` and dispatch commands — no component owns mutation state anymore. GridDesigner is refactored to be a thin view over the store (its internal state moves out).

### Preview + save
- The canvas already renders through `compile()` + paged.js — no change.
- Debounced (250ms) recompile on every dispatched command.
- Save writes the AST + theme to the existing template row via the existing hook (`usePublishPackVersion` / draft save path). Publish flow is unchanged; the studio just calls the same mutations.

### Non-goals for this session (explicit)
- No engine changes; no new AST primitives.
- No server-side PDF (Phase 3).
- No collapsing of `field_row`/`label_fill` into a single primitive (Phase 2).
- No changes to rules / tax templates / return templates editors (Phase 4).
- Drawer editor stays in the code for one release as a fallback (feature-flagged off), then removed.

### Files touched (approximate)
- **New:** route file, `studio/state.ts`, `studio/commands.ts`, `studio/CanvasOverlay.tsx`, `studio/canvasBridge.ts` (iframe postMessage), `studio/OutlineTree.tsx`, `studio/InsertPalette.tsx`, `studio/TopBar.tsx`, `studio/InspectorHost.tsx`, `studio/useUndoRedo.ts`, tests under `src/test/localization/studio/`.
- **Edited:** `CertificateV3Editor.tsx` (becomes an inspector host that delegates to per-node inspectors; loses drawer chrome), `GridDesigner.tsx` (state moves to store, commands go through dispatch), `compile.ts` (already emits `data-ce-node` — verify markers on every leaf including inline label_fill, add missing ones only if a test flags them).
- **Untouched:** engine types, engine compiler behaviour, paged.js integration, pack registry, publish/version lifecycle, all Deno mirrors, all rendered output.

### Success criteria for Phase 1
- A publisher can build the KE P9 (or any pack template) end-to-end without ever opening the raw JSON editor.
- Every AST change originates from a `dispatch(command)`; no component mutates `document` directly.
- Undo/redo works across every editing surface.
- Preview updates within 300ms of any edit.
- `certificate-editor.country-agnostic.test.ts` still passes — the studio adds no country tokens.
- The drawer entry point is gone from primary navigation; deep links resolve to the studio route.
