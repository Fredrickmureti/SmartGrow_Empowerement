# Enterprise Document Platform — Thermal Layout Audit & Reconstruction

**Symptom under audit:** selecting an 80/58/40 mm PDF print policy for a POS receipt (or any document) produces a PDF where the content is laid out at the top and the rest of the sheet is a very tall blank strip — "as if the A4 was compressed to fit the thermal width".

The reply below follows the requested six phases. Every current-state claim is grounded in a file:line read done before writing this plan.

---

## Phase 1 — Architecture audit (what is actually there)

### 1.1 Layering already in place (ADR-0008)

The system does implement the three-layer separation the request asks about:

| Layer | Owner | Evidence |
|---|---|---|
| Document Model (paper-agnostic) | `supabase/functions/generate-document/index.ts` fetchers → `DocumentData` | `docs/audit/2026-05-11-printing-architecture.md:15-60`, `docs/printing-pipeline.md:40-60` |
| Paper Format + Render Mode | `document_print_policies` (business, branch, document_type) → resolved in `src/services/printing/PrintClient.ts:82-185`; `paperFormat` + `renderMode` forwarded to server | `supabase/migrations/20260511153525_*.sql`, `src/services/printing/PrintClient.ts:61-249`, `src/hooks/useDocumentPrint.ts:52-190` |
| Transport | Existing POS hardware stack (Electron / LocalAgent / WebUSB / `agent/` TCP raw bytes) | ADR-0008 §Decision.3, `docs/audit/2026-05-11-printing-architecture.md:20-40` |

### 1.2 Renderers

- **`PdfBuilder`** (`supabase/functions/_shared/pdf/PdfBuilder.ts:38-170`) is paper-agnostic. It exposes:
  - `PaperPreset = "a4" | "letter" | "a5" | "80mm" | "58mm" | "40mm"`
  - `PaperSpec = { widthMm; heightMm: number | "auto" }`
  - Derives `density: "narrow"` automatically when `widthMm ≤ 90` (line 141-143).
  - Applies a 6 pt gutter on narrow, `theme.pageMargin` (72 pt) on wide (line 148-149).
- **PDF components** already branch on `density === "narrow"`:
  - `BrandedHeader.ts:96`, `LineItemsTable.ts:189-195`, `TotalsBlock.ts:46-49`, `RecipientBlock.ts:39-42`, `NotesBlock.ts:29`, `SignatureBlock.ts:58`, `DataTable.ts:376`.
- **ESC/POS path** is a separate renderer for `renderMode === "escpos"`; continuous-media by construction (no page).
- **POS receipt HTML/ESC/POS legacy stack** (`src/services/receipt/*`, `src/lib/receiptConfig.ts`) still coexists — used for the live cashier flow, not for the PDF path under audit.

### 1.3 Resolution chain for a print request

`useDocumentPrint` / `PrintClient` → resolves `document_print_policies` for (business, branch, document_type) → forwards `{ paperFormat, renderMode }` to `generate-document` → `generateDocumentPdf(data, template, { paperFormat })` → `PdfBuilder.create({ paperFormat })`.

**All plumbing exists and works.** The paper choice reaches the builder correctly.

### 1.4 The critical defect

`PdfBuilder.PAPER_PRESETS` (lines 51-58) declares:

```
"80mm": { widthMm: 80,  heightMm: 297 },
"58mm": { widthMm: 58,  heightMm: 297 },
"40mm": { widthMm: 40,  heightMm: 297 },
```

Then `create()` line 134:

```
const heightMm = paper.heightMm === "auto" ? 297 : paper.heightMm;
```

Consequences:

1. A "thermal" PDF is rendered on a **80 × 297 mm** rigid sheet (a portrait strip almost as tall as A4).
2. Content is drawn top-down from `y = pageHeight - margin` (line 121). A short receipt consumes only a fraction of the 297 mm; the rest is blank.
3. `heightMm: "auto"` is declared in the type but never honoured — the ternary collapses it back to 297 mm. There is no post-render "resize final page to consumed Y" pass.
4. `newPage()` (line 178) always adds a new fixed-height page, so multi-page thermal output also gets tall blank tails on every page.

This is precisely the observed symptom.

---

## Phase 2 — Industry comparison

Continuous-roll media is a solved problem in every mature stack; the shared pattern is: **width is fixed by the paper profile, height is derived from consumed content ("auto height" / "receipt paperformat").**

| System | Pattern |
|---|---|
| Odoo | `paperformat_id` with `page_height = 0` ⇒ auto height; QWeb template renders once; wkhtmltopdf/WeasyPrint sizes the page to content. POS uses ePOS HTML (ESC/POS via IoT Box) for hardware. |
| SAP Retail / Xstore / Dynamics 365 Commerce | Distinct "receipt formatter" DSL (SAP: POS DM Receipt; Xstore: `ReceiptDoc.xml`; D365: Receipt Formats) — width-bound, height-free, ESC/POS transport. A4 forms live in a separate SmartForms / SSRS pipeline. |
| Toast / Square / Shopify POS / Lightspeed | ESC/POS receipt renderer, continuous height; PDF invoices are a different renderer. When a PDF *preview* of a receipt exists, it is width-bound and cropped to the consumed height. |
| LS Central / NCR | Report Layout Selection resolves (document type × store × device) → chooses (template, paper profile, printer); paper profile can be "continuous". |

**Architectural principle common to all of them:** *paper is a property of the profile, not of the template; continuous media is a first-class paper profile — never emulated by a very tall sheet.*

The three-layer ADR-0008 architecture in this codebase matches the mature pattern. The missing piece is the "continuous height" implementation of the paper profile.

---

## Phase 3 — Business-process framing

Documents in scope traverse this lifecycle:

```text
Sales:      Quotation → Sales Order → Picking → Delivery Note → Invoice → Payment → Receipt
Purchase:   RFQ → Purchase Order → GRN → Bill → Payment → Remittance
POS:        Cart → Tender → Receipt (+ optional Tax Invoice on request)
```

Each business event has a legitimate presentation on both A4 (accountant/customer copy, filing, email attachment) and thermal (counter hand-off, back-office in-store copy, till drawer). Which one is issued is a **policy** attached to (document_type, branch), not a property of the template — which is why `document_print_policies` is keyed on `(business, branch, document_type)`.

Presentation invariants that must hold on thermal continuous media, independent of document type:

- Width is fixed by the paper profile (58/80/40 mm minus gutter).
- Height is the sum of what was actually drawn.
- Long descriptions wrap onto their own line (narrow layout in `LineItemsTable`).
- Totals are stacked full-width, not two-column (already implemented in `TotalsBlock:46-49`).
- Header/recipient collapse to single column (already implemented in `BrandedHeader:96`, `RecipientBlock:39-42`).
- Statutory documents (payslip, tax cert, statutory return, audit cert) are pinned to A4 by `assertStatutoryPaper` (ADR-0008 §Statutory exceptions) — they must remain unaffected.

---

## Phase 4 — Root-cause verdict

**Verdict: partially implemented roadmap. Not an architectural flaw, not a UI/config mismatch, not a symptom to hack around.**

Evidence:

1. Architecture is sound (Phase 1.1): the three-layer split exists, the resolver picks up `paperFormat`, and every layout component has a real `narrow` branch — thermal layouts are **not** bypassed and A4 is **not** being "compressed".
2. The exact defect is a single unimplemented capability inside the paper profile layer: **continuous height**. `PdfBuilder.create` treats `heightMm: "auto"` as `297 mm` (line 134) and the thermal presets are seeded with a placeholder `297 mm` height (lines 54-57). No page-resize pass exists.
3. What the user sees ("content at top, huge blank below") is the deterministic output of drawing a correctly-narrowed layout onto a 80 × 297 mm sheet.

**What this is *not*:**
- Not an A4-being-scaled-to-thermal problem. The narrow layout is being rendered; the sheet is just too tall.
- Not a template-per-paper duplication problem — the components are already paper-aware.
- Not a policy resolver problem — the correct `paperFormat` reaches the renderer.

---

## Phase 5 — Target architecture (delta only)

The target architecture is the current one plus a **first-class Continuous Paper Profile** and one convention:

```text
PaperSpec:
  widthMm: number
  heightMm: number | "continuous"      // renamed from "auto" for clarity

Paper profile rules:
  - "continuous" is legal ONLY for renderMode ∈ { "escpos", "pdf" }
    (HTML preview also honours it via CSS @page { size: <width>mm auto })
  - Thermal presets (80mm / 58mm / 40mm) default heightMm = "continuous"
  - A4 / Letter / A5 keep fixed heights (unchanged)
  - Statutory pins (assertStatutoryPaper) reject "continuous"

Renderer contract (PdfBuilder):
  - Reserve final page geometry until save().
  - For "continuous": render into a virtual sheet, track max consumed Y,
    then resize the (single) final page to (widthMm, consumedY + bottomMargin).
  - Multi-page is FORBIDDEN when heightMm = "continuous" — thermal
    output is one continuous strip. newPage() throws in that mode.
  - Wide/fixed paper behaviour is byte-identical to today.

Policy layer (document_print_policies):
  - No schema change. paper_format string already accepts "80mm"/"58mm"/"40mm";
    the meaning of those presets is what changes.

Presentation layer (components):
  - No change; the density === "narrow" branches already exist and are correct.

Transport layer:
  - No change.
```

Principles this preserves:
- Single Responsibility — paper geometry stays in `PdfBuilder`; components stay presentation-only.
- Open/Closed — new profile is additive; existing presets untouched.
- Separation of Concerns — policy vs paper vs renderer vs transport remain independent.
- Single Source of Truth — `document_print_policies` remains the only policy store; `PdfBuilder.PAPER_PRESETS` remains the only paper registry.

---

## Phase 6 — Implementation roadmap (phased, reversible)

Every phase is independently shippable, keeps A4 byte-identical, and includes a rollback lever.

### Phase T1 — Continuous paper primitive (renderer only)

- Extend `PaperSpec.heightMm` semantics: accept `"continuous"` (keep `"auto"` as deprecated alias).
- Change thermal presets to `heightMm: "continuous"`.
- In `PdfBuilder.create`, when `paper.heightMm === "continuous"`:
  - Render into a temporary page at a generous provisional height (e.g. 2000 mm cap).
  - Track `maxConsumedY` as components draw.
  - On `save()`, clone content into a final page of `(widthMm, pageHeight - min(y) + bottomMargin)` and drop the provisional page. (pdf-lib supports `PDFPage.setSize`.)
- Make `newPage()` throw `ContinuousMediaMultiPageError` when in continuous mode; components already avoid `newPage()` on narrow density in practice, so this is a guardrail.
- **Rollback:** feature flag `PDF_CONTINUOUS_HEIGHT` (env). Off ⇒ old ternary path.
- **Verification:** unit tests that (a) an 80 mm invoice with 3 lines produces a page whose height ≈ consumed content, (b) A4 outputs are byte-identical to a golden fixture, (c) statutory generators still refuse thermal via `assertStatutoryPaper`.

### Phase T2 — Statutory guard hardening

- `assertStatutoryPaper` rejects any `paper.heightMm === "continuous"` in addition to non-A4 widths.
- Architecture test: every generator carrying `// STATUTORY PAPER PIN` calls `assertStatutoryPaper`.
- **Rollback:** revert file — no data migration.

### Phase T3 — Policy UI truthfulness

- In the Print Policy admin surface, show a small hint next to thermal presets: "Continuous roll — height auto-sized." (No schema/behavior change.)
- **Rollback:** copy-only.

### Phase T4 — HTML preview parity (optional, follow-up)

- The in-app preview surface (`src/services/printing/previewSurface.ts`) uses `@page { size: 80mm auto }` when the resolved policy is thermal, so the on-screen preview matches the printed PDF.
- **Rollback:** revert CSS block.

### Phase T5 — ESC/POS alignment audit (follow-up, not required for the fix)

- Confirm that for policies with `renderMode: "escpos"` the ESC/POS builder consumes the same `DocumentData` — no changes to layouts, only assertion tests to prevent future divergence. (Already the ADR-0008 direction.)
- **Rollback:** tests only.

### Architecture tests to add (permanent)

- `PdfBuilder` rejects `newPage()` under `heightMm: "continuous"`.
- Every thermal preset resolves to `heightMm: "continuous"`.
- `assertStatutoryPaper` rejects continuous.
- A4 golden-PDF byte-comparison for one representative invoice (regression guard).

### Explicitly out of scope

- No new template forks.
- No parallel `generate-receipt-from-document` edge function.
- No changes to component branching (they are already correct).
- No changes to `document_print_policies` schema.
- No touching of the POS live cashier HTML/ESC/POS stack in `src/services/receipt/*` — that is a separate lifecycle.

---

## Technical appendix (for the engineer implementing T1)

- `PdfBuilder.PAPER_PRESETS` at `supabase/functions/_shared/pdf/PdfBuilder.ts:51-58` — change `heightMm` for `80mm`/`58mm`/`40mm` from `297` to `"continuous"`.
- `PdfBuilder.create` at line 134 — replace `heightMm === "auto" ? 297 : heightMm` with a branch that records `mode: "continuous" | "fixed"` on `BuilderState`.
- Introduce `state.maxConsumedY` (updated in `ensureSpace` and drawing helpers, or after each component).
- `save()` at line 202 — when `mode === "continuous"`, call `this.page.setSize(width, consumedHeight)` before `doc.save()`.
- pdf-lib API: `PDFPage.setSize(width, height)` resizes without re-flowing content because the coordinate origin is bottom-left; we must translate content (or draw from a top anchor equal to the final height). Simplest reliable option: render into a large provisional page, then on save recompute a final page and re-issue the draw operators through a second pass — or use `page.setMediaBox(x, y, w, h)` to reveal only the used strip (top-anchored). The chosen approach must be covered by the byte-equality A4 test to prove wide output is untouched.
- Update the JSDoc on `PaperSpec.heightMm` to describe `"continuous"` as the canonical value; keep `"auto"` as a deprecated alias for one release.

---

**Decision requested:** approve this plan (or push back on any phase) before implementation begins. Nothing under `src/`, `supabase/`, or `agent/` will be modified until then.
