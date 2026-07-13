# Certificate Publishing — Architecture Audit + WYSIWYG Editor Track

Two-phase engagement. Phase 1 is a verification audit (no assumptions from the previous agent are trusted). Phase 2 is the corrective build: kill the "everything opens in a right-side sheet with 3 cramped columns" UX and give publishers a real visual designer.

The country-agnostic invariant is non-negotiable and already partially enforced by tests — we extend it, we don't relax it.

---

## Phase 1 — Verification audit (read-only)

Deliverable: a short audit note committed to `docs/audit/certificate-publishing-2026-07.md` recording, per claim, "verified / partial / not landed / regressed", with file:line evidence.

Claims to verify from the previous agent:

1. **v4 engine primitives** (`grid`, `list`, `label_fill`, `field_row`, `columns`, `page_break`) actually compile in both `src/features/localization/lib/engine/compile.ts` and the Deno mirror `supabase/functions/_shared/certificate-engine/compile.ts`, and the two files are byte-identical apart from the documented preamble.
2. **Country-agnostic invariant** — scan engine + editor + GridDesigner + genericExample for the forbidden token list. Confirm the arch test actually fails when a token is introduced (mutate locally, run test, revert).
3. **`data-ce-node` click-to-select bridge** — verify it is emitted by `compile()`, that `CertificateHtmlSurface` installs the postMessage listener, and that the editor actually scrolls/highlights on click. Not just present in code — works end-to-end in the running app.
4. **Validator rewrite** — v4-only bodies validate; legacy v3 still validates; a body mixing v3+v4 nodes validates.
5. **KE P9 template** (`templates/keP9.ts`) — compare structurally against `Original-p9-Template.pdf`: 4-row header stack, letter column A–O, `Kshs.` unit row, sub-instructions on E1/E2/E3, IMPORTANT + Attach two-column block, A4 landscape, Times body / black rules / no zebra. Record deltas — do not fix in Phase 1.
6. **Editor "full-viewport 3-pane" claim** — confirm whether certificate edit still opens inside `WorkflowSheet` (right-hand drawer) or is genuinely a full page. Based on `LocalizationFormShell` + `PackEntityTabs` this is almost certainly still a sheet; the audit must state so plainly.
7. **Tests** — run `bun test` for the localization + certificate-engine suites and record pass/fail. Do not treat the previous agent's claim of "127 passing" as evidence.

Audit output drives Phase 2 scope. If any Phase-1 claim is a regression (e.g. tokens leaked back in), it is fixed as a Phase-2 P0.

---

## Phase 2 — Corrective build

### 2.1 Kill the right-side sheet for localization editing (P0)

The user's core complaint: every add/edit opens a `WorkflowSheet` drawer that crams "legal metadata + inputs + outputs" into three columns. This is wrong for certificates and wrong across all localization entities.

- Introduce dedicated routes under `/localization/packs/$packId/…`:
  - `certificates/new`, `certificates/$templateId/edit`
  - `returns/new`, `returns/$templateId/edit`
  - `rules/…`, `tokens/…`, `authorities/…`, `garnishments/…`, `bank-exports/…`, `requirements/…`, `governance/…`
- Each route is a full page with its own `head()` metadata, breadcrumbs, save/publish action bar pinned to the top, and a "Back to pack" link.
- `PackEntityTabs` rows become links (row click = navigate) instead of "open sheet" handlers. Bulk actions stay on the tab.
- `LocalizationFormShell` / `WorkflowSheet` usages inside localization are removed for edit surfaces; the shell may survive only for genuinely small confirm-style flows (e.g. "duplicate version").
- Save contract, dirty-state guard, permission checks, and audit-log writes are preserved.

### 2.2 Certificate Designer — real WYSIWYG (P0, the headline)

Replace the current three-Card `CertificateV3Editor` with a **Designer** page whose layout is:

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Toolbar: Insert ▾  Table ▾  Text ▾  Layout ▾  Theme ▾  Undo Redo  │  ← top ribbon (Word/Excel feel)
├────────────┬───────────────────────────────────────┬────────────────┤
│  Outline   │                                       │  Inspector     │
│  (tree of  │       Canvas — live paged.js          │  (context-     │
│   nodes,   │       rendering at true paper size,   │   sensitive:   │
│   drag to  │       zoom + fit-width, rulers,       │   node props,  │
│   reorder) │       drop targets, cell selection)   │   theme,       │
│            │                                       │   bindings)    │
└────────────┴───────────────────────────────────────┴────────────────┘
│  Bottom: Diagnostics · Tokens used · Validation · Sample data ▾     │
```

Key behaviours:

- **Direct manipulation on the canvas.** Click any node → selected (already partially wired via `data-ce-node`). Drag handles on `grid` columns resize widths in mm on the ruler. Right-click a cell → merge right / merge down / split / insert row above/below / set variant (label · unit · letter · note · total).
- **Excel-like grid designer.** Keep `GridDesigner` engine, but present it as the canvas cells themselves (not a separate strip below). Column ruler, row gutter, band labels ("Header", "Data", "Footer") in the gutter. Cell inspector on the right shows `bind_key`, `format`, `align`, `nowrap`, variant, sum-of.
- **Insert menu** (Word-like): Heading · Paragraph · Field row · Label + fill · List · Table (grid) with a rows×cols picker · Columns region · Legal notice · Signature strip · Spacer · Page break · Image.
- **Bindings picker** is a searchable dropdown over `pack_token_registry` (existing hook), shown inline in the inspector — no free-text JSON.
- **Theme panel** edits the pack-owned `Theme` (fonts, rule weight, header shade, letter shade, zebra, heading case, numeric tracking) with live preview. No hard-coded aesthetics in the compiler — invariant preserved.
- **Sample data.** Load a fixture from `pack_test_fixtures` (or an ad-hoc JSON) so the canvas shows real values, not tokens. Toggle "Show tokens / Show values".
- **Zoom, fit-width, rulers, page navigator** (for multi-page docs — `page_break`).
- **Validation surfaced inline** — errors from the validator badge the offending outline node and canvas node.
- **Country-agnostic guard extended** to the new Designer files (add to the existing arch test's scan list).

Non-goals for this iteration: freehand drawing, arbitrary absolute positioning, image editing. The Designer stays structured — publishers assemble typed primitives, they don't draw pixels. That's what keeps the engine renderable server-side (Phase D of the memory doc, still deferred).

### 2.3 KE P9 template correction pass (P1)

Only after the Designer lands and using the audit deltas from Phase 1.6, adjust `templates/keP9.ts` so its **structure** matches the KRA original: column count, header row stack, letter row (A–O), `Kshs.` unit row, sub-instructions under E1/E2/E3, the two-column IMPORTANT + Attach footer, A4 landscape, statutory-form theme. No pixel-perfect chase. Any change must be expressible purely as v4 AST + Theme — if it isn't, the Designer is missing a primitive and we add the primitive to the engine (both mirrors) rather than special-casing keP9.

### 2.4 Tests + guardrails

- Extend `certificate-engine.compile.test.ts`:
  - v4 grid with colspan+rowspan+footer sum_of renders expected HTML shape.
  - `data-ce-node` present on every top-level node type.
  - Theme CSS variables emitted for every documented token.
- Extend country-agnostic scan to the new Designer directory.
- Add architecture test: no localization edit page is mounted via `WorkflowSheet` (regex over the routes directory).
- Playwright smoke: open KE P9 in the Designer, click a cell, confirm inspector opens with the correct node id; change a theme token; confirm canvas updates.

---

## Sequencing

1. Phase 1 audit note (single doc, ~1 day of tool time). No code changes.
2. Route scaffold for dedicated localization pages + move certificate edit off the sheet (unblocks the UX complaint immediately, even before the Designer lands).
3. Designer canvas + outline + inspector + insert menu, wired to existing `compile()` and `GridDesigner` internals.
4. KE P9 structural pass.
5. Tests + guardrails + Playwright smoke.

Every step preserves the invariant: **the engine never learns about P9, KRA, PAYE, or any country**. The Designer is a country-agnostic authoring tool; KE P9 is just the first non-trivial pack template it produces.

## Technical notes

- Router: TanStack Start file-based routes under `src/routes/localization.packs.$packId.certificates.$templateId.edit.tsx` etc. Each route has `head()` with a unique title/description.
- Data loading: `context.queryClient.ensureQueryData(queryOptions)` in the loader, `useSuspenseQuery` in the component. No `useEffect`+`fetch`.
- Auth: `_authenticated` layout for all localization pages; publisher grants enforced via existing `pack_publisher_grants` capability check inside the loader-called server function.
- Save: existing server functions in `supabase/functions/…` are reused; only the client mount changes. Validator remains authoritative (`validate-localization-payload`).
- Undo/redo in the Designer is client-only (in-memory command stack); persistence still goes through the same save contract, so pack versioning + `pack_audit_log` are unaffected.
- No changes to `PdfBuilder` / accountantMono / server-side rendering pipeline. Certificate PDF path (paged.js today, Cloudflare Browser Rendering later — ADR/memory Phase D) is out of scope for this track.

## Out of scope (explicitly deferred)

- Phase D server-side PDF producer.
- P2.a dependency graph, P2.b semantic diff, P2.c simulator, P2.d 4-eyes review (ADR 0056).
- Additional country packs (Ghana, Uganda, US W-2, UK P60). The Designer must be able to author them; shipping them is a follow-on.
