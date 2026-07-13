
# Certificate Publishing — Audit Findings & Continuation Plan

## What the previous agent actually shipped (verified in code)

| Claim | Reality in repo | Verdict |
|---|---|---|
| v4 AST (grid, list, label_fill, field_row, columns, page_break) | Types + compile.ts + Deno mirror present. Tests cover v4 primitives. | ✅ real |
| Pack-owned Theme (var(--ce-*)) | `ENGINE_DEFAULT_THEME`, per-template `theme` on keP9. | ✅ real |
| Country-agnostic engine | "no country tokens" test scans compile.ts + types.ts. | ✅ real |
| GridDesigner spreadsheet editor | 565-line component, cell select + merge/split/Σ + column ruler. | ✅ real |
| CertificateV3Editor — no raw-JSON textareas, per-node inspectors | Confirmed. | ✅ real |
| KE P9 rebuilt on v4 with 4-row header stack + IMPORTANT/Attach columns | `keP9.ts` uses GridNode, label_fill identity, columns for IMPORTANT. | ✅ real |
| Phase D server-side PDF | Explicitly deferred; still paged.js + browser print. | ⚠ acknowledged gap |

## What is genuinely broken (matches your complaint)

1. **Editor is mounted inside a right-side Sheet (`LocalizationFormShell`)**, then internally splits into a 3-column grid (`grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px]`). Body editor, live preview, and field inspector all fight for space in a drawer. Not befitting a sensitive statutory-document edit surface.
2. **Editing is form-driven, not canvas-driven.** `CertificateV3Editor` is a vertical stack of typed inspectors; the preview is a separate paged.js iframe next to it. You cannot click a cell in the preview to edit it — the two panes are not wired together. GridDesigner is spreadsheet-style but only opens for the *selected* grid node inside the inspector list, not on the actual document canvas.
3. **Validation still requires legacy nodes.** `validateV3Body` blocks save unless the document contains `identity_strip`, `signature_strip`, AND `matrix` nodes — even though the KE P9 v4 template deliberately replaced them with `label_fill` / `field_row` / `grid`. This means the shipped canonical template technically fails its own editor validator; save-path only works because the KE P9 body already has legacy remnants or is edited outside the editor. This is a landmine.
4. **KE P9 information architecture is closer but still not right.** Header stack exists but the letter row (A, B, C … O) and the "Kshs." unit row are collapsed into grid header cells rather than dedicated visual rows a publisher can see and edit as bands. IMPORTANT / Attach block renders as two `columns` but no visual boundary between numbered items and the "Please Note" tail; the E1/E2/E3 sub-instruction band lacks the italic small-caps treatment.
5. **Country-agnostic invariant is intact in code**, but there is no test asserting the *editor* is country-agnostic (only compile.ts + types.ts are scanned). Extend the guardrail.
6. **No visual outline of the document.** Publisher sees a flat list of node cards. No tree, no page thumbnails, no way to reorder large sections cheaply.

## What we will do

### Phase 1 — Land the editor as a first-class page (not a drawer)
- Add a dedicated route (`/localization/packs/:packId/certificates/:code/edit`) that renders `CertificateTemplateEditor` full-viewport with a 3-pane layout (Outline · Canvas · Inspector), matching how a tenant edits an invoice on its own page.
- Replace the "pencil → Sheet" launcher in `PackEntityTabs` with a router navigation. Keep the Sheet code path only as a fallback for the return-template editor until it too is promoted.
- Remove the internal `xl:grid-cols-[…_320px]` inside `CertificateTemplateEditor`; the page shell owns layout now.

### Phase 2 — Real WYSIWYG canvas (click-to-edit on the rendered document)
- Reuse the existing `CertificateHtmlSurface` (paged.js iframe) as the canvas. Instrument `compile.ts` to emit stable `data-node-id` / `data-cell-id` / `data-band` attributes on every element it renders (heading, label_fill, list li, grid header cell, grid data column, grid footer cell, columns child, signature caption, spacer). No visual change, only hooks.
- Add a thin selection overlay layer inside the iframe: a `MessageChannel` bridge posts `{type:"select", nodeId, cellId?}` on click; parent responds with `{type:"highlight", rect}` and mounts the matching inspector in the right pane. Same primitive powers double-click-to-edit-inline for text nodes (label, heading, list item, cell literal).
- For `grid` nodes, embed `GridDesigner` **on top of** the rendered grid in the canvas (absolutely positioned band overlays for header/data/footer) — Merge/Split/Σ operate directly on the visible cells the user can see. This is the Excel-like experience you described.
- Left pane: document outline tree (drag to reorder sections, click to scroll canvas + open inspector). Bottom of the outline: page thumbnails (paged.js already paginates in the iframe).

### Phase 3 — Fix the validator and lock the country-agnostic invariant
- Rewrite `validateV3Body` to require *semantic roles*, not node types: "the document must contain at least one identity block (`identity_strip` OR any `label_fill`/`field_row` bound to `employer.*` and `employee.*`), one signature area, and one tabular data block (`matrix` OR `grid`)." Legacy templates keep validating; v4 templates stop being false-negatives.
- Extend the "no country tokens" test to scan the whole `src/features/localization/lib/engine/**` and `src/features/localization/components/CertificateV3Editor.tsx` + `GridDesigner.tsx` — proving the editor itself never mentions Kenya/KRA/P9/PAYE/…
- Add a regression test that compiles `KE_P9_V4_TEMPLATE` and asserts `validateV3Body(body).ok === true` — closes the landmine.

### Phase 4 — KE P9 blueprint fidelity (localization-pack work, not renderer work)
- Restructure `keP9.ts` header stack so band 3 (letters A–O) and band 2 ("Kshs.") are their own visible header rows the publisher can select and re-style, not fused into a `colspan` cell. This is achievable with the existing `GridHeaderCell.band` primitive if we surface it in the header-band inspector; if a v4 primitive gap surfaces during this rebuild, extend `GridHeaderCell` (headers are country-agnostic — cells with role="letter" / role="unit").
- Rebuild IMPORTANT/Attach two-column block as one `columns` containing two `list` nodes with a `caption` on each, plus a trailing `rich_text` "Please Note" strip. All content stays as literals inside the pack.
- Verify against `Original-p9-Template.pdf` layout blueprint (structure, not pixel) — cell splits, letter cells, "Kshs." unit cells, footer TOTAL, signature strip position.

### Phase 5 — (Deferred, unchanged) Server-side PDF via Cloudflare Browser Rendering
Left as the previous agent's Phase D. Not part of this handoff unless you say so.

## Technical details

- **Selection bridge:** `postMessage` between host page and iframe (`allow-scripts allow-same-origin` already set). Node ids are `${type}:${indexPath}` — deterministic and derivable from AST traversal in both compile.ts and the editor, so the iframe never ships app code.
- **Grid overlay:** the canvas iframe reports each grid's absolute rect via `getBoundingClientRect()` on layout; parent renders an absolutely positioned `<GridDesignerOverlay>` in the host document that mirrors the same column widths. Editing mutates the AST, which re-compiles and re-renders the iframe — one source of truth.
- **Deno compile.ts mirror:** any change to compile.ts (adding `data-node-id` attributes) must be mirrored in `supabase/functions/_shared/certificate-engine/compile.ts` byte-identically. Existing test `certificate-engine.compile.test.ts` will fail if not — good guardrail.
- **Route wiring:** TanStack Router; add a new file under `src/routes/` for the full-page editor and route guards for `admin`-mode publisher.
- **Validator change is a breaking soft-check:** existing legacy templates keep validating (they have `identity_strip`/`matrix`/`signature_strip` nodes); only false negatives on v4 disappear.
- **No changes to payroll calculations, tokens, or generate-tax-certificate edge function** in this plan. Presentation-only.

## Out of scope

- Server-side PDF (Phase D remains deferred).
- Return-template editor promotion (touch only if the shared shell demands it).
- New countries / packs.
- Any change to payroll engines, tokens, or calculation rules.

## Success criteria (matches your definition)

- Publisher edits a certificate on a full page with a rendered document canvas — click any cell/heading/label to edit in place; grid cells merge/split/sum on the visible table.
- Save is not blocked for v4-only documents.
- Engine + editor scan clean for country tokens.
- KE P9 structure mirrors the KRA blueprint (bands, letters row, Kshs row, IMPORTANT/Attach two-column, TOTAL footer, signature strip) with no renderer changes required for the next country.
