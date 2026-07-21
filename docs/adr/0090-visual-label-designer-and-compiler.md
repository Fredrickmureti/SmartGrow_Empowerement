# ADR-0090 — Visual Label Designer & Compiler Ownership

- Status: Accepted (2026-07-21)
- Related: ADR-0085 (rendering ownership), ADR-0087 (envelope ownership),
  ADR-0088 (media-relative geometry), ADR-0089 (barcode identity)

## Context

Prior to Phase 18, `label_templates.body` stored raw engine-native strings
(ZPL, EPL, ESC/POS). Operators editing shelf and product labels had to
type `^FO`, `^BY`, `^BCN` by hand. Two consequences fell out:

1. Labels drifted across DPI (203 vs 300) because the raw body was
   authored at one printer's dot pitch, even after ADR-0088 introduced
   media-relative `{{mm:n}}` tokens — operators kept reaching for
   absolute dot coordinates because that is what the reference manuals
   show.
2. Every module authored templates in a slightly different style, so the
   receipt team, the shelf-label team, and the shipping team each
   maintained their own snippets. Any centralised change (a new
   `{{lot_number}}` token, a barcode symbology swap) required N edits.

## Decision

Label templates are authored as a **structured document** (`LabelDoc`) —
a list of positioned elements in millimetres — persisted in
`label_templates.body_json JSONB`. `src/services/printing/labelCompiler.ts`
is the single owner of `LabelDoc → engine bytes` translation. `body`
(raw string) is preserved for backwards compatibility and kept in sync
with a compiled snapshot on save; the dispatcher prefers `body_json` when
present.

Element model (v1):

```ts
type LabelElement =
  | { type: 'text';     xMm; yMm; text; fontSize?; bold? }
  | { type: 'variable'; xMm; yMm; token; prefix?; suffix?; fontSize?; bold? }
  | { type: 'barcode';  xMm; yMm; token; symbology: 'code128'|'ean13'|'qr'; heightMm?; moduleMm?; hri? }
  | { type: 'line';     xMm; yMm; wMm; hMm }
  | { type: 'box';      xMm; yMm; wMm; hMm; thicknessMm? };
```

The compiler emits **content only** — the dispatcher still injects the
paper envelope (`^PW`/`^LL`, `q`/`Q`), so ADR-0087 continues to hold.

ESC/POS output (Phase B2, 2026-07-21): the compiler positions elements
using `ESC $ nL nH` (absolute horizontal position), `ESC J n` (feed) and
`GS !` (character size). Prior implementation dropped `xMm`/`yMm` and
concatenated text with newlines, which garbled labels on ESC/POS thermal
label printers (common on 80×50 rolls sold as "receipt printers").

## Consequences

- Adding a new label size = adding a media profile row.
- Adding a new template = drag/drop in the Platform → Hardware editor.
- Adding a new engine = one new `compile<Engine>` function in the
  compiler; every existing template renders on it automatically.
- Every module that prints labels goes through the same seam
  (`useLabelPrint` → `labelDispatch` → `labelCompiler`), so the barcode
  identity contract (ADR-0089), envelope discipline (ADR-0087) and
  media-relative geometry (ADR-0088) all remain single-owner.

## Guardrails

- `src/test/printing/label-compiler.test.ts` — asserts no envelope
  tokens in compiled output, DPI-scaled geometry, and (Phase B2)
  positioned ESC/POS output.
- `src/test/printing/label-coverage.test.ts` — every module that
  prints a physical label dispatches by template key + workflow, not
  raw bytes.
- `src/test/printing/media-geometry-single-owner.test.ts` — the
  compiler and drivers all go through `mediaGeometry.mmToDots`.
