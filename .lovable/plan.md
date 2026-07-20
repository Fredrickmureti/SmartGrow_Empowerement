
## Finding: the discrepancy is real and structural

The user's suspicion is correct. Thermal PDF and raw ESC/POS are produced by two different row-producers today.

Two pipelines in the codebase:

```text
PDF path (recently fixed, looks good)
  DocumentData
    → documentToReceiptInput()
    → buildReceiptLines()            ← supabase/functions/_shared/receipt/lines.ts  (454 lines, shared engine)
    → renderThermalPdf()             ← consumes ReceiptLinesResult (rows + LineMeta)

ESC/POS wire path (what Espresso emulator receives)
  DocumentData
    → buildDocumentEscPos()          ← supabase/functions/_shared/escpos/builder.ts  (procedural section emitters, LEGACY)
    → raw bytes to printer
```

Confirming evidence in the tree:
- `generate-document/index.ts` calls `buildDocumentEscPos(...)` at lines 1888/1936 (preview) and 2406/2542 (print), and `renderThermalPdf(rows)` at 2728–2746. Two independent renderers, same document.
- `supabase/functions/_shared/escpos/parity_gate_test.ts` was written specifically to measure this gap. It fingerprints both outputs at 80/58/40 mm and prints a structural diff, but the assertion is gated by `EXPECT_PARITY = false` with the comment: *"the shared engine is missing: fiscal_block, notes/terms, payment_allocations, refund_banner, copies+cut policy, code128 barcode, per-payment reference lines, cashier/register labels, and the R2 'copies' duplication logic."* This is a known, tracked debt that was never closed.
- `renderLinesEscPos.ts` header states its explicit purpose: *"A follow-up swap-out will route buildDocumentEscPos through this emitter and delete the duplicated procedural section emitters."* That swap-out is what's missing.

So today Espresso (or any real thermal printer) sees rows produced by the legacy procedural builder, while the PDF preview and the on-screen `MonospacePreview` see rows produced by `buildReceiptLines`. Different column math, different section order, different spacing rules, different bold/large decisions — hence the "subtle differences" and "terrible" appearance under raw ESC/POS.

This is architectural, exactly as the parent prompt anticipated. The receipt engine has one canonical row producer already (`buildReceiptLines`); the ESC/POS wire path just isn't wired through it yet.

## Goal

One row producer feeds every output: on-screen preview, thermal PDF, and raw ESC/POS bytes. The Wave 6b parity gate flips to `EXPECT_PARITY = true` and passes at 80/58/40 mm.

## Plan

### Phase 1 — Verify the gap objectively (no code changes yet)
1. Run the existing parity gate test and capture the structural diff at 80/58/40 mm. The printed "lines only in LEGACY / lines only in SHIM" output is the ground-truth list of what the shared engine is missing.
2. Cross-check against the caller list — confirm no other call site produces ESC/POS bytes for physical printers besides `buildDocumentEscPos` (grep `print_raw`, `printRawBytes`, `EscPosReceiptDriver`, agent print route).
3. Publish the diff as the acceptance checklist for Phase 2.

### Phase 2 — Close the shared-engine gaps in `buildReceiptLines`
Add the sections the parity-gate comment enumerates, as first-class rows in `supabase/functions/_shared/receipt/lines.ts` (and the mirrored client `src/lib/receipt/preview/buildReceiptLines.ts`). Each addition is a set of `{lines, meta}` rows plus profile-aware column math — never a coordinate hack:
- `fiscal_block` (eTIMS CU / QR / control unit lines)
- `notes` / `terms` (wrapped to content width, honoring left margin)
- `payment_allocations` and per-payment reference lines
- `refund_banner`
- `cashier_name` / `register_id` labels
- `code128` barcode row (produces a `LineMeta.barcode` marker analogous to today's `qr` marker; PDF renders as barcode glyph, ESC/POS emits `GS k` bytes)
- `copies` policy (n × body) and `cut` policy — modeled as a document-level directive on `ReceiptLinesResult`, executed by the emitter, not by the row producer

Every addition ships with a unit test in `supabase/functions/_shared/receipt/` covering 80/58/40 mm.

### Phase 3 — Teach `renderLinesEscPos` the new markers
Extend the emitter to honor:
- `LineMeta.barcode` → native Code128 sequence (with textual fallback when caps absent).
- Document-level `copies` and `cut` directives from `ReceiptLinesResult`.
- Kitchen/receipt printer capability negotiation already present in `EscPosReceiptDriver` / agent routes remains the transport concern — no logic duplicated here.

### Phase 4 — Cut over `buildDocumentEscPos` to the shared engine
Replace the body of `buildDocumentEscPos` with:

```ts
export function buildDocumentEscPos(doc, opts) {
  const input = documentToReceiptInput(doc);
  input.settings.paper_size = opts.width;
  return renderLinesEscPos(buildReceiptLines(input), {
    caps: opts.caps, cut: opts.cut ?? true, feedLinesAfter: opts.feedLinesAfter ?? 4,
  });
}
```

Keep the exported name and signature so no call site (four in `generate-document/index.ts`, plus tests) changes. This is the canonical-owner consolidation the parent prompt asked for.

### Phase 5 — Flip the parity gate and delete dead code
1. Set `EXPECT_PARITY = true` in `parity_gate_test.ts`. It must pass at 80/58/40 mm; that's the guard that keeps preview/PDF/ESC/POS aligned forever.
2. Delete the procedural section emitters in `escpos/builder.ts` and `escpos/blocks.ts` that are no longer reachable.
3. Update `docs/printing-pipeline.md` and ADR 0008 with the final ownership diagram — `buildReceiptLines` is the sole row producer, `renderThermalPdf` and `renderLinesEscPos` are the only two emitters, transports (`EscPosReceiptDriver`, agent, WebUSB) remain untouched.

### Phase 6 — End-to-end verification against Espresso
1. Generate the same POS receipt at 80/58/40 mm as (a) thermal PDF and (b) raw ESC/POS bytes → Espresso capture.
2. Confirm section order, alignment, separators, totals column, footer, cut all identical between the PDF render and the Espresso capture.
3. Attach diffs / screenshots to the handoff.

## What we are NOT doing
- No cosmetic tweaks to the PDF renderer — it's already correct.
- No changes to transports, drivers, or the agent — the discrepancy is in the row producer, not the wire.
- No new receipt template surface; the shared engine already exists.

## Deliverable definition of done
- One row producer (`buildReceiptLines`) feeds preview, PDF, and ESC/POS.
- Parity gate asserts byte-equality at 80/58/40 mm and is green.
- Legacy procedural ESC/POS section emitters are removed.
- Espresso capture and thermal PDF are visually identical for the golden fixture across all three widths.
