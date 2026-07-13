
# Certificate Publishing Architecture — Audit & Continuation Plan

## 0. Missing inputs

You referenced two attachments (`System_Gen.pdf`, `Original-p9-Template.pdf`) but nothing is mounted at `/mnt/user-uploads/` this turn. I can proceed on the architectural work without them, but for step **3 (KRA structural diff)** to be meaningful I need the two PDFs re-attached. Please drop them on the next message.

## 1. Verified state of the previous agent's work

I walked the actual code, not the handoff notes. What is genuinely landed:

- **Engine is country-agnostic.** `src/features/localization/lib/engine/types.ts` and `compile.ts` know nothing about P9/PAYE/KRA/Kenya. The regression test `src/test/localization/certificate-editor.country-agnostic.test.ts` scans the editor + grid designer + example template for forbidden tokens and passes. Schema v4 (grid / list / label_fill / field_row / columns / page_break / theme) is real.
- **Dedicated full-page route exists.** `/_admin/localization-packs/:packId/certificates/:templateId/edit` is wired via `AdminLocalizationCertificateEdit.tsx` and mounted from `PackEntityTabs`. The Sheet drawer no longer opens for admin-mode certificate editing.
- **3-pane workspace exists.** `CertificateTemplateEditor` renders Outline · Canvas · Inspector with a top ribbon whose Insert menu appends every v4 primitive; clicks on the paged.js canvas round-trip a `data-ce-node` id back to the inspector.
- **Renderer parity.** Browser `compile.ts` is described as a mirror of `supabase/functions/_shared/certificate-engine/compile.ts` — same AST types, same node visitors. Playwright smoke to prove byte-parity is NOT written yet.

What is claimed but incomplete or fragile:

- **Editor is still form-shaped.** Every node's UI is a stack of Inputs / Selects / Textareas in the right pane. Clicks on the canvas scroll a form card into view. This is a big step up from the drawer, but it is not the InDesign / Word / report-designer model the brief asks for (no direct manipulation on the canvas, no drag-reorder, no resize handles on grid columns, no cell merge UI, no marquee selection).
- **Only certificates got the treatment.** Return templates, rules, tokens, bank exports, garnishments, statutory authorities, pack requirements, publisher governance still open in the right-side `WorkflowSheet`. The "dedicated workspace" principle is not yet a module-wide pattern.
- **No structural diff against KRA P9.** The follow-up item 2.3 was not started.
- **No Playwright smoke** proving `compile()` browser ↔ edge output equivalence (item 2.4).
- **Legacy surfaces still shipping:** `BlocksEditor.tsx`, `TemplateEditor.tsx`, `_shared/certificateSections.ts`, `_shared/certificateMatrix.ts`, `_shared/renderTemplateBody.ts` — v2 code paths that the "one AST, one renderer" principle says must go.
- **`generate-tax-certificate/index.ts`** still enforces the legacy `sections[]` contract in its refusal branch (`render_refusal_test.ts` locks it in). The v3/v4 document is authored on `body.document`, not `body.sections`, so the edge function has to be reworked or the two contracts reconciled before v4 packs can be filed for real.

## 2. Architectural verdict

The **foundation is sound**: AST is generic, renderer is generic, packs own presentation, dedicated route exists, WYSIWYG selection loop works. Do **not** rip and replace.

The **experience is not yet enterprise-grade**: it's a form-per-node inspector next to a preview, not a document designer. And the pattern is applied to one entity out of eight in the Localization module.

Plan is therefore: keep the AST & renderer, replace the inspector-as-form with a direct-manipulation canvas, decommission the legacy v2 surfaces, extend the dedicated-workspace pattern to the rest of the module, and prove parity end-to-end.

## 3. Phased plan

### Phase A — Close the previous agent's loop (1–2 turns)

A1. **compile.ts parity test.** Add a Playwright/Vitest smoke that runs the shared fixture through the browser `compile()` and the edge `compile.ts`, snapshots the HTML+CSS, and fails on drift. This is the load-bearing invariant of the whole architecture; it must be enforced by CI, not by code review.
A2. **KRA P9 structural diff.** Once you re-attach the two PDFs, produce a written diff (sections present/missing, column groupings, header stack depth, footer totals, signature block, legal notice placement, typography register) and file it as `docs/adr/0061-certificate-p9-parity-audit.md`. Feed the gaps into Phase B as concrete AST or theme requirements — **not** as renderer changes.
A3. **Reconcile `generate-tax-certificate`.** Drop the `sections[]` refusal branch, accept `body.document` (v3/v4), keep the "must render something" gate. Update `render_refusal_test.ts`. Without this, published v4 packs cannot actually file.

### Phase B — Turn the inspector into a document designer (3–5 turns)

Goal: the canvas is the primary editing surface; the right pane becomes a properties panel for the *selected* thing, not the whole document.

B1. **Direct manipulation on the canvas.** Selection outlines, drag-to-reorder top-level nodes, drag handles at section edges to insert Spacers, delete/duplicate affordances on hover. Implement as an overlay layer on top of the paged.js rendering keyed by `data-ce-node`.
B2. **Grid designer in place.** Replace the standalone `GridDesigner.tsx` modal with in-canvas column resize handles, right-click → merge/split cells, header-row add/remove buttons on the grid frame. Cell content still authored in the properties pane; structure edited on the canvas.
B3. **Properties pane, not form pane.** Right pane shows only the selected node's properties + its bindings; no more scrolling through every node's form. Legal metadata moves to a dedicated "Template" tab in the pane (still on the same page).
B4. **Bindings picker.** A first-class token picker driven by `pack_token_registry`, with search, type filter, and inline "insert as {{token}}" — replaces free-text dotted paths in the inspector.
B5. **Decommission v2.** Delete `BlocksEditor.tsx`, `TemplateEditor.tsx`, `_shared/certificateSections.ts`, `_shared/certificateMatrix.ts`, `_shared/renderTemplateBody.ts`, `certificateCompleteness.ts` (v2 shape). Migrate any remaining callers to v3/v4. One AST, one renderer, one editor — enforce with a lint rule that forbids imports of the deleted modules.

### Phase C — Generalise the workspace pattern (2–3 turns)

C1. **Dedicated routes for every editable localization entity:**
```
/admin-management/localization-packs/:packId/returns/:id/edit
/admin-management/localization-packs/:packId/rules/:id/edit
/admin-management/localization-packs/:packId/tokens/:id/edit
/admin-management/localization-packs/:packId/bank-exports/:id/edit
/admin-management/localization-packs/:packId/garnishments/:id/edit
/admin-management/localization-packs/:packId/authorities/:id/edit
/admin-management/localization-packs/:packId/requirements/:id/edit
```
Each opens a full-viewport editor with the same page-header contract as the certificate route. `PackEntityTabs` becomes a navigator, not a mounter of drawer editors.
C2. **Return templates** get the same 3-pane treatment (they already use a v3-ish AST via `ReturnTemplateEditor` + `ReturnPreviewPane` — align them on the same shell components rather than duplicating).
C3. **Rules / tokens / authorities** keep structured-form editors (they *are* configuration, not documents) but move out of the drawer into the dedicated route with a proper header, breadcrumb, and Save/Publish action bar.

### Phase D — Publisher productivity polish (1–2 turns)

D1. **Version compare as a page** (`/…/compare?from=vX&to=vY`) using the existing `PackDiffView` / `VersionCompareCard`, not a modal.
D2. **Pack Health** as a persistent left rail on the pack workspace, not a panel that appears/disappears.
D3. **Simulator entry point** on every editable entity ("Preview against fixture…") — cheap wire-up to what Phase P2.c of ADR-0056 will fully build.

### Phase E — Guardrails (continuous)

- Country-agnostic scan is already in place — extend it to the new files added in B/C.
- Add an ESLint rule `no-localization-drawer-editor` forbidding new `<WorkflowSheet>` usage under `src/features/localization/**`.
- ADR: `0061-certificate-publishing-studio.md` documenting the "AST-owned by pack, direct-manipulation canvas, dedicated workspace" decision so future agents don't retreat to the drawer pattern.

## 4. Non-goals in this pass

- Pixel-perfect KRA P9 reproduction. We fix the *architecture* so the KE pack **can** be authored to match; the pack content itself is a separate slice.
- Marketplace / 4-eyes review / semantic diff / full simulator — those are ADR-0056 P2 deferred tracks; touched only where Phase C/D benefits them incidentally.
- Additional country packs. Explicitly out of scope until the studio is done.

## 5. Technical notes (for the engineer, not the PM)

- `compile.ts` lives in **two** places (`src/features/localization/lib/engine/` and `supabase/functions/_shared/certificate-engine/`). Any AST change needs a synchronous edit to both plus the Phase A1 parity test. Do not let them drift.
- v3 → v4 is additive; keep both node types allowed in `validateV3Body` (already the case). Do not force-migrate stored bodies.
- The paged.js canvas already emits `data-ce-node="doc.<i>"` markers. Reuse those for the direct-manipulation overlay in B1 rather than inventing a parallel selector system.
- `PackEntityTabs.tsx` is 882 lines and is where the drawer-based editors are mounted; expect that to become mostly a `<Link>` list after Phase C.

## 6. First action if you approve

Re-attach the two PDFs and I will start with **A1 (parity test)** and **A3 (edge function contract)** in parallel — both are load-bearing and neither depends on the PDFs. The PDF-driven **A2 (structural diff)** runs alongside as soon as the files are available.
