
# Localization Editor — Workspace Audit & Redesign Plan

## 1. What exists today

`CertificateTemplateEditor.tsx` (587 lines) is the canonical shell mounted by both admin and tenant via `CertificateEditorPage`. Current shape:

- Fixed height container `h-[calc(100vh-8rem)]` with a top toolbar strip, a horizontal `ResizablePanelGroup` (Editor 60% / Preview 40%, min 35/25), and a footer save bar.
- Left pane: node tree + `CertificateV3Editor` (1030 lines) — per-primitive inspectors (grid, list, label_fill, field_row, columns, page_break) plus `GridDesigner`, `ThemeInspector`, `TokenAwareTextarea`.
- Right pane: `CertificatePreviewPane` (paged.js iframe).
- Sibling editors (`TemplateEditor`, `ReturnTemplateEditor`, reference editors under `components/reference/*`) mount inside `PackEditorShell` tabs and do **not** share the same workspace chrome — they are plain stacked forms.

The `ResizablePanel` primitive is already present, but nothing else in the workspace treats itself as a real IDE: no docking, no focus modes, no persistence, no keyboard workflow, and the inspector inputs are the same shadcn `<Input>` used in settings pages.

## 2. UX audit — findings

### A. Layout & workspace flexibility
1. Half-width editor is the wrong default for grid/table/expression authoring. Preview always visible steals horizontal room the grid designer needs the most.
2. Split ratio is not persisted; every reload resets to 60/40.
3. There is no way to hide either pane, pop the preview out, dock it to the bottom (better for landscape statutory forms like KE P9 A4-landscape), or enter a distraction-free editor/preview-only mode.
4. Fixed `h-[calc(100vh-8rem)]` breaks on smaller laptops and short viewports (inspector scrolls inside a scroll inside a scroll).
5. Node tree lives inside the editor pane's scroll region — it competes with the inspector for vertical space instead of being its own dockable rail.
6. Sibling editors in `PackEditorShell` tabs (returns, tax templates, account templates, bank exports, garnishments, statutory authorities) do not share this shell at all — inconsistent authoring experience across the pack.

### B. Input & control usability
1. All string inputs are the standard shadcn `<Input>` — single line, no horizontal auto-grow, no expand-to-dialog affordance. Long label_fill labels, token expressions, and bind_keys get clipped.
2. `TokenAwareTextarea` is used in some places but not consistently — expressions and formulas in `TemplateFieldInspector`, mapping editors, and grid cell `bind_key` fields fall back to plain inputs.
3. Grid designer cell inspectors are stacked vertically inside the narrow right column of the editor pane → double-nested horizontal squeeze.
4. No monospaced font for machine values (codes, tokens, bind keys, JSON), no code-editor affordances (bracket matching, wrap toggle) for the few JSON-shaped fields that remain.
5. No "expand this field" popover/dialog pattern for long values (labels, notes, legal text, expressions).
6. Textareas are not resizable and don't auto-grow.
7. Inspector density is uniform — required, common, and advanced properties share the same weight; nothing collapses.

### C. Preview
1. Always-on right dock; no bottom-dock option (natural fit for landscape statutory forms).
2. No zoom/fit/page controls surfaced at the workspace level; no "preview only" fullscreen.
3. No pop-out to a second window (real value for dual-monitor authors comparing scanned statutory PDFs to the rendered output).

### D. Navigation & keyboard
1. No global shortcuts (⌘S save, ⌘P toggle preview, ⌘B toggle tree, ⌘⇧F focus mode, ⌘/ toggle inspector).
2. Node tree click is the only way to move between nodes; no arrow-key traversal, no next/prev-node hotkeys.
3. Save button lives only in the footer — no dirty indicator, no keyboard save, no autosave draft.

### E. Cross-cutting
1. Same problems repeat in `TemplateEditor` (rules), `ReturnTemplateEditor`, and every reference-data editor because they don't share a shell. Any fix must be a reusable primitive, not a one-off in the certificate editor.

## 3. Reference patterns worth borrowing

- **VS Code**: activity bar + collapsible side panels + bottom panel + command palette + persisted layout + focus (Zen) mode.
- **Figma**: left tree + center canvas + right inspector, all three independently collapsible; inspector fields with inline expand-to-popover for long values.
- **Google Docs / Word**: preview *is* the editor (single canvas), inspector rides on the side — a mode we should offer for WYSIWYG authoring later, but not the default here because our editor is structural.
- **Notion / Odoo Studio**: property panels that collapse into accordions with "Advanced" progressive disclosure.
- **ERPNext Print Format Builder**: dockable preview, JSON drawer.
- **Adobe Acrobat / Power BI**: bottom-dock preview for landscape documents; pop-out preview window.

Principles taken (not visuals):
- Three independently resizable/collapsible regions.
- Layout state persists per user.
- Every long-text field has an "expand" escape hatch.
- Progressive disclosure separates required from advanced.
- Keyboard is a first-class input device.

## 4. Proposed workspace model

A reusable `AuthoringWorkspace` primitive under `src/design-system/primitives/` composed of:

```text
┌────────────────────────────────────────────────────────────────────┐
│  WorkspaceTopBar  (title · breadcrumbs · layout modes · save)      │
├──────────┬─────────────────────────────────┬───────────────────────┤
│          │                                 │                       │
│  LEFT    │   MAIN EDITOR                   │  PREVIEW  (dockable)  │
│  RAIL    │   (grid designer / inspector)    │  right | bottom |     │
│  (tree)  │                                 │  popout | hidden      │
│          │                                 │                       │
│ collapse │  resizable ◀━━▶                 │  resizable ◀━━▶       │
├──────────┴─────────────────────────────────┴───────────────────────┤
│  Footer / status bar (dirty · shortcuts · validation counts)       │
└────────────────────────────────────────────────────────────────────┘
```

Features:
- **Three panels**: left rail (node tree / outline), main (inspector + designer), preview.
- **Layout modes** in the top bar: `Split` (default) · `Editor only` · `Preview only` · `Focus` (hide rail + preview) · `Bottom preview` (dock preview under editor for landscape docs).
- **Resizable + persisted**: sizes stored per-user in localStorage keyed by workspace id; restored on reopen; sensible min/max.
- **Preview options**: dock right, dock bottom, pop-out (new window with a small mirror route), fullscreen, zoom/fit controls.
- **Keyboard**: ⌘S save · ⌘B tree · ⌘/ inspector · ⌘⇧P preview · ⌘⇧F focus · J/K next/prev node.
- **Command palette hook** (uses existing `CommandPaletteProvider`) with workspace-scoped actions.

## 5. Reusable input primitives

New primitives under `src/design-system/primitives/inputs/`:

- `<AutoGrowInput>` — single-line, grows horizontally to content with min/max, keeps cursor visible; used for labels, codes, bind keys.
- `<ExpandableTextField>` — input + "expand" icon → dialog/popover with a large resizable textarea; used for legal notes, long labels, descriptions.
- `<AutoGrowTextarea>` — content-height textarea with a drag handle; word-wrap toggle.
- `<CodeField>` — monospaced, optional token highlighting; wraps `TokenAwareTextarea` for expression/token fields; used for bind_key, sum_of, format, expressions.
- `<InspectorSection>` — accordion with `defaultCollapsed` for Advanced; persists per section id.

Every certificate inspector, grid cell inspector, `TemplateFieldInspector`, mapping editor, and reference-data editor migrates to these primitives so the fix is systemic, not per-field.

## 6. Phased implementation

**Phase 1 — Workspace shell primitive (foundation)**
- Build `AuthoringWorkspace` + `useWorkspaceLayout` hook (persistence, modes, shortcuts) in `src/design-system/primitives/`.
- Full test coverage: layout persistence, keyboard shortcuts, mode transitions.
- No feature-editor changes yet.

**Phase 2 — Adopt in `CertificateTemplateEditor`**
- Replace current `ResizablePanelGroup` with `AuthoringWorkspace`.
- Extract node tree into the left rail.
- Add layout mode switcher, persistence, pop-out preview route.
- Remove fixed `h-[calc(100vh-8rem)]`; use natural flex fill from `CertificateEditorPage`.

**Phase 3 — Input primitive rollout**
- Ship the input primitives listed in §5.
- Migrate `CertificateV3Editor` inspectors, `GridDesigner` cell inspectors, `ThemeInspector`, `TemplateFieldInspector`.
- Introduce `InspectorSection` with Advanced collapsed by default (theme letter spacing, zebra, heading case, etc.).

**Phase 4 — Cross-editor consistency**
- Migrate `TemplateEditor` (rules), `ReturnTemplateEditor`, and every editor under `components/reference/*` to mount inside `AuthoringWorkspace` (with preview panel hidden when a live preview isn't meaningful — the layout still gives them the same input primitives, top bar, and keyboard model).

**Phase 5 — Polish**
- Command palette actions ("Focus mode", "Dock preview bottom", "Pop out preview", "Next / Previous node", "Toggle Advanced").
- Status bar: dirty indicator, validation counts, last-saved timestamp.
- Docs update in `mem/features/certificate-rendering.md` + `docs/design-system.md`.

## 7. Technical notes

- Use existing `@/components/ui/resizable` (react-resizable-panels); it already supports `autoSaveId` — use it for persistence instead of hand-rolling localStorage where possible.
- Pop-out preview: a new lightweight route `/localization/preview-window/:sessionId` that subscribes to a `BroadcastChannel` the main editor publishes AST to; no server work.
- Keyboard: reuse `useHotkeys` pattern already in the codebase (`CommandPaletteProvider`).
- No changes to compile engine, AST, `paged.js` pipeline, or persistence adapters — this is a workspace/chrome/input redesign only, respecting the certificate-rendering constraint memory.
- Country-agnostic invariant untouched; no engine files edited.

## 8. Out of scope (explicit)

- Compile engine, AST v3/v4, paged.js pipeline, `keP9.ts`.
- Server-side PDF (Phase D remains deferred).
- Business logic in any editor — inputs change shape, not what they persist.
- Visual redesign of the app-level chrome (topbar, sidebar) — workspace shell is scoped to the editor page.
