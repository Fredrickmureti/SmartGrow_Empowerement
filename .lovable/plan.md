
# POS Receipt Rendering — Verification & Continuation Plan

## Position

The previous agent claims Phases 1–4 of `.lovable/plan.md` are complete:
one canonical `Line[]` AST (ADR-0084), single row producer in
`supabase/functions/_shared/receipt/lines.ts` driving Preview + thermal
PDF + ESC/POS, paper geometry centralised on `PrinterProfile`, dual
`ReceiptDocumentModel` / `DocumentData` intentional per ADR-0086, and a
guardrail suite (ESLint `no-raw-escpos-bytes`, six architecture tests,
ADRs 0084/0085/0086).

Files confirmed to exist during exploration:
`supabase/functions/_shared/receipt/{lines.ts, documentToInput.ts,
engine/PrinterProfile.ts, engine/ColumnLayout.ts, pdf/renderThermalPdf.ts}`,
`supabase/functions/_shared/escpos/{builder.ts, renderLinesEscPos.ts,
renderDocumentEscPos.ts, parity_gate_test.ts}`,
`src/lib/receipt/engine/PrinterProfile.ts`, ADRs 0084 and 0085.
Everything else — behaviour, parity, guardrail coverage — is unverified.

Nothing new is implemented until Phase A passes.

## Phase A — Independent verification (read-only, no code changes)

A1. **Test suite**: run `bunx vitest run src/test/architecture/` and
`bunx vitest run supabase/functions/_shared/receipt supabase/functions/_shared/escpos supabase/functions/_shared/pdf`.
Every test must pass. Record failures; a failing guardrail is Phase A
work, not Phase 5 work.

A2. **Single-producer invariant (ADR-0084)**: grep for other row
producers. `escpos/builder.ts`, `renderThermalPdf.ts`, and
`MonospacePreview` must each consume the `Line[]` from
`receipt/lines.ts` and contain no header/meta/items/totals/payments
assembly of their own. Any local assembly = regression.

A3. **Rendering ownership (ADR-0085)**: confirm ESLint rules
`no-raw-escpos-bytes`, `no-raw-pdf-lib-in-app`, `no-direct-barcode-lib`,
`no-raw-zpl-outside-printing` exist and are wired in `eslint.config.js`.
Grep `src/**` for `pdf-lib`, `bwip-js`, raw `qrcode` (non-`qrcode.react`),
raw `\x1B`/`\x1D` bytes, and any `// RENDERER-EXEMPT:` opt-outs — each
opt-out must cite a documented reason.

A4. **Model boundary (ADR-0086)**: ensure ADR-0086 exists (only 0084 and
0085 were located during exploration; 0086 is claimed but not sighted).
If missing, that's a Phase A defect. Run
`pos-receipt-model-boundary.test.ts` and
`pos-receipt-cross-model-consistency.test.ts`.

A5. **Paper geometry centralisation**: confirm `renderThermalPdf.ts`
imports `paperGeometry` from `PrinterProfile` and has no local
`PAPER_WIDTH_MM` / `PAPER_MARGIN_MM` tables. Confirm the client mirror
`src/lib/receipt/engine/PrinterProfile.ts` matches its server twin
byte-for-byte (guarded by `receipt-engine-mirror-parity.test.ts`).

A6. **Byte-parity spot check**: pick one representative POS receipt
fixture, render it through the PDF path and through the ESC/POS emitter,
and diff the resulting `Line[]` (not the bytes). They must be identical.
Any divergence means `escpos/builder.ts` still skips the shared producer
and is a Phase A defect.

A7. **Printer profile coverage**: verify 40 mm, 58 mm, 80 mm are all
present in `FONT_COLUMNS`, `DEFAULT_MARGIN`, and `PAPER_GEOMETRY`. If
the 80 mm ESC/POS output still overflows in the emulator (the symptom
that triggered this audit), inspect the operative profile — likely a
mismatch between the printer's actual character density and the
`FONT_COLUMNS['80mm']` table, or a `columnsOverride` that isn't being
sourced from the assigned printer profile. Document the root cause
before proposing a fix.

Deliverable: a short verification report listing, per item, PASS /
FAIL / MISSING with file:line evidence. Any FAIL/MISSING is appended to
this plan as remedial work and executed before Phase 5.

## Phase B — Remediation (only if A surfaces defects)

For each Phase A defect: fix in place, add a regression test, keep the
architecture direction (Line[] AST, ownership table, dual-model per
0086). Do not rebuild.

Likely candidates given the reported ESC/POS overflow:

- The active printer profile isn't being consumed by the ESC/POS
  emitter — the emitter is picking a default width instead of the one
  the operator selected. Fix at the profile resolution site, not by
  editing `FONT_COLUMNS`.
- Font-B (9-dot) is being assumed while the driver actually emits
  Font-A bytes (or vice versa). Reconcile via `PrinterProfile.font`
  and the emitter's font-select command.
- `marginCols` is 0 for 80 mm on the operative profile, printing to
  the head edge. Ensure `DEFAULT_MARGIN['80mm'] = 2` is actually used.

## Phase C — Resume Phase 5.1: shelf-edge labels

Only after Phase A (and any Phase B) is green.

Scope, per the existing plan:

- Add `DocumentType = 'shelf_label'` to `DocumentData`.
- Add `layouts/shelfLabel.ts` under
  `supabase/functions/_shared/receipt/layouts/` that emits the shared
  `Line[]` AST (name, price, unit price, barcode, SKU footer).
- Wire a label-printer profile (58 mm and 40 mm columns, ZPL caps) into
  `PrinterProfile`.
- Add the ZPL emitter path in `src/services/printing/` (ZPL owner per
  ADR-0085). Do NOT add ZPL assembly to `escpos/`.
- Add a golden-`Line[]` test and a ZPL byte-golden test.

Phase 5.2–5.4, Phase 6, Phase 7 remain queued and untouched by this
turn.

## Guardrails carried through every phase

- No new row producer. Extending the receipt means adding a `Line`
  variant to `receipt/lines.ts` plus one media-specific render per
  emitter.
- No `pdf-lib`, `bwip-js`, raw `qrcode`, or raw ESC/POS/ZPL bytes under
  `src/**` outside sanctioned driver directories.
- Client mirror of `PrinterProfile` / row producer stays byte-identical
  to the server copy; parity test must stay green.
- Update `.lovable/plan.md` after each completed sub-phase; do not
  mark work complete without a passing test.

## Explicit non-goals for this turn

- Redesigning the AST or replacing the dual-model split (ADR-0086 stands
  until superseded).
- Cosmetic PDF changes; the AST governs layout.
- Migrating A4 documents to `Line[]` (Phase 6, deferred).
