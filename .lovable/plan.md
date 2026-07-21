# Enterprise Printing Architecture — Verification & Continuation Plan

## Execution Status (2026-07-21)

### Phase A — Verification of Phase 18 · COMPLETE

| Claim                              | Verdict  | Evidence                                                                                          |
|------------------------------------|----------|---------------------------------------------------------------------------------------------------|
| `body_json` column + resolver RPC  | PASS     | `supabase/migrations/20260721032756_*.sql` adds the column and updates `resolve_label_template`.  |
| Dispatcher prefers `body_json`     | PASS     | `labelDispatch.ts` L320 — `isLabelDoc(...) ? compileLabelDoc(...) : tpl.body`.                    |
| Editor writes body + body_json     | PASS     | `HardwareLabelTemplates.tsx` L414–423 compiles snapshot into `body` and stores `body_json`.       |
| Compiler emits content only        | PASS     | `label-compiler.test.ts` asserts no `^PW`/`^LL` / `q`/`Q`.                                        |
| Guardrail tests present            | PASS     | `label-coverage.test.ts`, `media-geometry-single-owner.test.ts`, `label-barcode-policy.test.ts`.  |
| ADR-0090 documented                | **FIXED**| Was missing — added `docs/adr/0090-visual-label-designer-and-compiler.md`.                        |
| ESC/POS geometry (B2 preview)      | **FIXED**| Old `compileEscPos` discarded xMm/yMm. Rewritten to use `ESC $ / ESC J / GS !`; test added.       |

Phase 18 is genuinely shipped for ZPL and EPL. ESC/POS was a superficial pass — hardened this turn.

### Phase B — Remaining gaps · QUEUED

B1 (receipt compiler), B3 (document compiler), B4 (media/printer admin audit), B5 (scanner platform), B6 (event coverage matrix) — not started this turn. Execution order unchanged from the plan below.

---

## Original Plan

The previous engineer marked Phase 18 (Visual Label Designer) as SHIPPED. Before adding scope, I will verify each claim against the actual codebase, then close the architectural gaps that Phase 18 did not address (receipts, PDFs, cross-module scanning). No file has been modified yet — this plan is the deliverable.

## Phase A — Verify Phase 18 claims (read-only)

Confirm each SHIPPED bullet from `.lovable/plan.md` is real:

1. **Data model** — inspect the migration that adds `label_templates.body_json`; confirm `resolve_label_template` RPC returns it. Check whether `body` really stays in sync with a compiled snapshot on save (compiler is deterministic, but the editor's save path must call it — verify in `HardwareLabelTemplates.tsx`).
2. **Compiler** — `labelCompiler.ts` is present; confirm `label-compiler.test.ts` exists and asserts no envelope + dpi scaling. Look for gaps: QR sizing on EPL, `escpos` compile currently drops geometry entirely (verified in file — this is a real defect for ESC/POS label printers).
3. **Dispatcher wiring** — `labelDispatch.printLabelByTemplate` prefers `body_json` (confirmed line 320). Verify legacy raw `body` bodies still round-trip through `renderTemplateBody`.
4. **Visual editor** — open `HardwareLabelTemplates.tsx` and verify three-pane designer, variable picker catalog, and that Save writes `body_json` AND recompiles `body`.
5. **Guardrails** — confirm `label-coverage.test.ts`, `media-geometry-single-owner.test.ts`, and `label-barcode-policy.test.ts` all exist and run under the current test config.
6. **ADR-0090** — the dispatcher comment references ADR-0090 but no ADR file for 0090 appears in the tree listing (0085/0087/0088/0089 exist). Verify whether ADR-0090 was written or is missing.

Exit criteria for Phase A: a written verification note per bullet (pass / partial / missing) added to `.lovable/plan.md` before any code changes.

## Phase B — Close the gaps Phase 18 did not address

Phase 18 only covered *labels*. The parent prompt requires one coherent architecture across every printable artifact. These gaps are real based on the current tree:

### B1. Receipt rendering is a separate pipeline
- ESC/POS receipts are rendered outside `labelCompiler` (there is no `receiptCompiler.ts`; receipt bytes are produced ad-hoc via `escpos-commands.ts` and driver-side code).
- **Action:** introduce a `ReceiptDoc` (analogous to `LabelDoc`) and a `receiptCompiler.ts` that emits ESC/POS bytes; migrate the current receipt renderer behind it. Reuse `mediaGeometry` (mm-based) so 58mm/80mm rolls are configuration, not code.

### B2. ESC/POS label engine drops geometry
- `compileEscPos` in `labelCompiler.ts` currently concatenates text with newlines, discarding `xMm`/`yMm`. That means any org using a thermal label printer that speaks ESC/POS (common on 80×50 rolls) prints garbled labels even after Phase 18.
- **Action:** implement true positioned ESC/POS output using ESC $ nL nH absolute-position and GS ! for scale; add a compile test parallel to the ZPL one.

### B3. PDF documents (sales, purchase, delivery, GRN) bypass the canonical seam
- Dispatcher routes `engine=pdf` to `a4_printer` via `pdfUrl`. There is no shared `documentCompiler` — PDFs are generated per-module (see `no-raw-pdf-lib-in-app.js` eslint rule).
- **Action:** define a `DocumentDoc` (sections, tables, headers) with a single PDF renderer service. Modules produce data + template key; renderer + dispatcher own everything else. Enforce via existing eslint guardrails.

### B4. Media & Printer profiles are configuration-first but not fully wired
- `media_profiles` and `printer_profiles` tables exist. Verify:
  - Admin UI to CRUD media profiles (Platform → Hardware → Media).
  - Printer capabilities (`supported_media_ids`, `dpi`, `command_language`) editable per printer, not derived from templates.
  - Templates target *media*, not *paper size string*. Confirm `label_templates.media_profile_id` FK and enforce non-null for new rows (nullable for legacy).

### B5. Barcode scanning as a platform service
- `src/services/scanner/` exists; audit whether it is a single shared service used by Inventory, Warehouse, Procurement, Cycle Count, POS — or POS-only.
- **Action:** if fragmented, extract a `ScanBus` with device-agnostic events (`scan:code`, `scan:context`), wire consumers via subscription rather than per-page keyboard hooks. Support: HID scanners (POS), phone camera (warehouse mobile), enterprise handhelds (Zebra/Honeywell — profiles already present in `docs/scanner/`).

### B6. Business-event coverage matrix
Produce (as a doc under `docs/printing-pipeline.md`) a matrix mapping every business event to its label/document template + workflow binding:
Receiving, Putaway, Picking, Packing, Shipping, Cycle Count, Stock Adjustment, Transfer, Sales Order, POS Sale, Return, Refund, Product Create, Lot Create, Shelf Reprice, GRN, Purchase Order, Vendor Return, Payslip, Asset Tag.
Any row without a wired template becomes a follow-up ticket, not silent absence.

## Phase C — Guardrails & tests

- Add an architecture test that fails if a new PDF is generated outside the document renderer (extend existing eslint rules).
- Add a compile-time test that every `label_templates.template_key` referenced in `label-coverage.test.ts` is seeded by `seed_default_label_templates()`.
- Add a receipt-compile test analogous to `label-compiler.test.ts`.
- Add ADR-0090 (visual designer + compiler ownership) — currently referenced but missing.

## Phase D — Execution order

1. Phase A verification note appended to `.lovable/plan.md`.
2. B2 (ESC/POS label geometry) — smallest correctness fix, no schema change.
3. B4 audit — confirm media/printer admin UX; add missing screens only if absent.
4. B1 (receipt compiler) — biggest lift, gated behind feature flag until parity tests pass.
5. B3 (document compiler) — after B1 pattern is proven.
6. B5 (scanner platform) — parallelizable with B3.
7. B6 doc + guardrail tests land alongside each phase.

## Technical notes

- No schema changes required before Phase A finishes; migrations only appear in B1/B3 for `receipt_templates` and `document_templates` (the `document_templates` table already exists — check whether it satisfies B3 or needs extension).
- Backwards compat: every phase keeps the legacy path alive behind an `if (structuredDoc) …` branch, matching the pattern already used by `labelDispatch` for `body_json`.
- Nothing here changes end-user label sizing — the operator-visible fix from Phase 18 (mm-based authoring) is preserved.

## Open questions (will not block Phase A)

1. Should the receipt compiler share the `LabelDoc` element model or use a receipt-specific one (columns, tables, weighted rows)? Recommendation: separate `ReceiptDoc` — receipts are flow layout, labels are absolute positioning.
2. Do we consolidate `document_templates` (existing table, 55 columns) into the new document renderer, or leave it as a legacy path and build DocumentDoc alongside? Recommendation: extend, don't replace, to avoid a big-bang migration.
