# Phase 18 — Visual Label Designer · STATUS: SHIPPED

Operators no longer see printer code. Templates are authored on a WYSIWYG canvas and compiled to ZPL / EPL / ESC-POS at dispatch time.

## Delivered

- **Data model** — `label_templates.body_json JSONB` (migration 2026-07-21). `resolve_label_template` RPC now returns `body_json` alongside `body`. `body` is preserved for backwards compat and kept in sync with a compiled snapshot on save.
- **Compiler** — `src/services/printing/labelCompiler.ts` turns a structured `LabelDoc` (elements in mm) into engine-native bytes using `mediaGeometry.mmToDots`. Emits CONTENT ONLY — the dispatcher still injects the paper envelope, so ADR-0087 continues to hold. Variables become `{{token}}` so the existing mustache pass keeps working.
- **Dispatcher wiring** — `labelDispatch.printLabelByTemplate` now prefers `body_json` when present and falls back to the legacy raw `body` string otherwise. Zero-breakage rollout for pre-existing raw ZPL/EPL templates.
- **Visual editor** — `HardwareLabelTemplates.tsx` rebuilt as a three-pane designer:
  - Toolbox: Text, Variable, Barcode, Line, Box, plus template metadata (name, key, engine, paper size).
  - Canvas: SVG rendering at true mm scale, drag-to-position, click-to-select, mm grid guide.
  - Inspector: property editor for the selected element (position, size, font, bold, barcode symbology + data source, HRI toggle, thickness).
  - Variable picker: curated catalog grouped by domain (Product, Traceability, Warehouse, Shipping) — no mustache typing.
- **Tests** — `src/test/printing/label-compiler.test.ts` asserts no envelope in compiled output and correct dpi scaling.

## Element model (v1)

```ts
type LabelElement =
  | { type: 'text';     id; xMm; yMm; text; fontSize?: 1..10; bold? }
  | { type: 'variable'; id; xMm; yMm; token; prefix?; suffix?; fontSize?; bold? }
  | { type: 'barcode';  id; xMm; yMm; token; symbology: 'code128'|'ean13'|'qr'; heightMm?; moduleMm?; hri? }
  | { type: 'line';     id; xMm; yMm; wMm; hMm }
  | { type: 'box';      id; xMm; yMm; wMm; hMm; thicknessMm? };
```

## Backwards compatibility

Legacy templates whose `body_json` is NULL keep printing exactly as before. The editor tags them "Legacy" and opens with an empty canvas — saving migrates them to the new model. No forced migration; no downtime.

## Guardrails still in force

- ADR-0087 — envelope injection stays in the dispatcher; compiler emits content only. Verified by `label-compiler.test.ts`.
- ADR-0088 — barcode identity contract still enforced by callers via `labelBarcode.ts`.
- ADR-0089 — no raw ZPL/EPL manipulation outside `useLabelPrint` / dispatcher / compiler. Verified by `label-coverage.test.ts`.

## Prior phases (recap)

- Phase 14 — mediaGeometry, envelope discipline (ADR-0087)
- Phase 16 — `PrintLabelButton` reusable seam + `useBranches` migration
- Phase 17 — Inventory, Warehouse and POS wiring coverage
- Phase 18 — Visual Label Designer (this doc)
