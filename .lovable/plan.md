# Phase 18 — Visual Label Designer

You are 100% right. `@a!GOODS RECEIVED / {{grn_id}} / VB` is EPL2 with mustache variables — an operator should never see that. The system must present a WYSIWYG canvas, capture intent as structured data, and compile to ZPL / EPL / ESC-POS in the background.

## Enterprise pattern being adopted

Same shape SAP Smart Forms, Oracle BI Publisher, NiceLabel, and BarTender use:

- **Model** — a template is an ordered list of typed *elements* on a millimetre-based canvas. No engine-specific tokens ever appear in the model.
- **Compile** — a pure function turns `elements[]` + resolved `media_profile` + engine into the printer's native bytes at dispatch time.
- **Author** — the UI is a drag-and-drop canvas + a property inspector + a variable picker. The user picks "Barcode" from a toolbar, drops it, chooses `{{barcode}}` from a dropdown, and drags a corner to resize — never types syntax.

## Architectural change

```text
DB (label_templates)          Runtime
────────────────────          ───────
+ body_json  JSONB   ────►   compileLabelBody(elements, media, engine) ──► ZPL/EPL/ESC-POS
  body       TEXT   (kept)   ▲
                             │  same mm→dot math via mediaGeometry.ts
                             │  (no new geometry owner)
                             │
Editor writes body_json.     Legacy raw `body` templates keep working —
Dispatcher prefers body_json  the dispatcher falls back to raw body when
when present.                 body_json is null (backwards compatible).
```

## Element model (v1)

```ts
type LabelElement =
  | { type: 'text';    id; x_mm; y_mm; w_mm?; text: string;
      font_size_pt: number; bold?: boolean; align?: 'left'|'center'|'right'; rotate?: 0|90|180|270 }
  | { type: 'variable'; id; x_mm; y_mm; w_mm?; token: string;   // {{barcode}}, {{name}}, {{price}}, ...
      font_size_pt: number; bold?: boolean; align?; rotate? }
  | { type: 'barcode';  id; x_mm; y_mm; w_mm; h_mm;
      symbology: 'code128'|'ean13'|'upca'|'qr'; token: string; show_hri?: boolean; rotate? }
  | { type: 'line';     id; x_mm; y_mm; w_mm; thickness_mm?: number }
  | { type: 'box';      id; x_mm; y_mm; w_mm; h_mm; thickness_mm?: number };
```

The `token` field is picked from a **variable dropdown** populated per template `kind` (product/lot/shipping/etc.), so users pick "Product barcode" from a menu — they never type `{{barcode}}`.

## Plan (execution order)

### 1. Data model
- Migration `add_label_templates_body_json.sql`: `ALTER TABLE public.label_templates ADD COLUMN body_json JSONB NULL;`. Preserve existing GRANTs; no RLS change (same table).
- Backfill is NOT attempted — existing rows stay `body`-only and continue to print correctly.

### 2. Compiler
- New module `src/services/printing/labelCompiler.ts`:
  - `compileZpl(elements, media, dpi) → string`
  - `compileEpl(elements, media, dpi) → string`
  - `compileEscPos(elements, media, dpi) → Uint8Array` (skeleton — receipt-adjacent; not the priority)
- All mm→dot conversions go through `mediaGeometry.ts` — no new geometry math.
- Compiler emits CONTENT ONLY (no `^PW`/`^LL`/`q`/`Q`); envelope stays with the driver per ADR-0087.

### 3. Dispatcher integration
- `printLabelByTemplate` / `renderTemplateBody`: if `body_json` is present, compile from it; otherwise use raw `body`. Substitution still runs on the compiler output the same way.
- Golden tests: compiling the seven canonical templates from a hand-authored `elements[]` must produce output that passes the existing envelope-guardrail and mm-scaling tests.

### 4. Visual designer UI (`HardwareLabelTemplates.tsx`)
- **Toolbar**: Add Text · Add Variable · Add Barcode · Add QR · Add Line · Add Box.
- **Canvas**: absolute-positioned SVG/HTML mm grid at the selected media size, drag to move, corner handle to resize. Snap to 0.5 mm.
- **Property inspector** (right panel): shows selected element's fields — X/Y/W/H in mm, font size in pt, bold, alignment, rotation, symbology, and a **variable picker dropdown** for `{{token}}`.
- **Variable picker**: sourced from a per-kind catalogue (`product` → Name, SKU, Barcode, Price, Unit; `lot` → adds Lot#, Expiry, Manufacture; `shipping` → Carrier, Tracking, Weight; `bin`/`pallet` → Location, LPN). No free-text mustache.
- **Live preview**: same `LabelPreview` component, but rendered from `elements[]` — no fragile ZPL regex parsing.
- **Advanced (collapsed by default)**: read-only view of the compiled ZPL/EPL for engineers who want to audit — hidden behind a `<details>` labelled "Show compiled output".

### 5. Migration path for existing templates
- Existing rows keep working via the raw-body fallback.
- Editor detects `body_json == null && body != ''` and shows a banner: *"This template was authored in the legacy code editor. Open the visual designer to modernize it."* Clicking starts a blank canvas seeded from the template `kind` — no auto-parse of raw ZPL (out of scope; parsing arbitrary ZPL is a rabbit hole).
- Once saved through the visual designer, `body_json` is populated and the raw code becomes derived output.

### 6. Guardrails / tests
- `label-compiler-mm-scaling.test.ts` — same `elements[]` produces proportionally-correct ZPL at 152 / 203 / 300 dpi.
- `label-compiler-no-envelope.test.ts` — compiler output never contains `^PW`, `^LL`, `q\d+`, `Q\d+,\d+`.
- `label-compiler-variable-picker.test.ts` — variable catalogue for each `kind` matches the tokens the runtime substitutes (`useLabelPrint` vars).
- ESLint: `no-raw-zpl-outside-printing` already prevents leakage; extend to forbid `body_json` writes with unknown element types.

### 7. Explicitly out of scope this phase
- Bidirectional legacy conversion (parsing existing ZPL bodies into elements).
- PDF engine compilation (label pipeline is thermal-first; ADR-0084/0085 govern PDF separately).
- Image / logo elements — deferred to Phase 19 once bucket + upload flow is designed.

## Invariants that MUST hold

- **One geometry owner**: `mediaGeometry.ts`. The compiler calls it; it doesn't reinvent mm→dot math.
- **Envelope stays with the driver** (ADR-0087) — the compiler emits body content only.
- **Barcode identity** (ADR-0089) — variable tokens for barcodes resolve through `resolveLabelBarcode`; the visual picker offers `Product barcode` and never raw `product.id`.
- **Templates remain data**, not code — `body_json` is a structured document, not JavaScript.

## Deliverable at end of Phase 18

An operator opens `/platform/hardware/labels`, clicks *New template*, sees a paper-shaped canvas, drags a barcode onto it, picks *Product barcode* from a dropdown, types "GOODS RECEIVED" into a text block, saves — and the system prints correctly on every bound Zebra / EPL / ESC-POS device without the operator ever seeing `^FO`, `@a!`, or `{{grn_id}}`.

## Next agent handoff

1. Verify Phase 17 (Inventory / Warehouse / POS caller wiring) is still green by running `bunx vitest run src/test/printing/`.
2. Confirm no drift in `mediaGeometry.ts` single-owner status.
3. Start with **step 1 (migration)** and **step 2 (compiler + golden tests)** before touching the UI — the compiler is the contract everything else depends on.
