
# Enterprise Printing Architecture — Continuation Plan

## Status snapshot (as of Phase 14 close-out completion)

**Currently active phase:** Phase 17 — Coverage across Inventory / Warehouse / POS (D15).
**Next task to pick up:** Phase 17 step 13 (Inventory callers) — see "Next agent instructions" below.

### ✅ Fully implemented and verified

**Phase 1–13 (from earlier agents)** — Ownership matrix (ADR-0085) with 4 ESLint guardrails,
`label_templates` + `media_profiles` + hardware-shaped `printer_profiles`, 5-tier
`resolve_label_template` resolver, media-agnostic default seed (`20260721005711`),
`mediaGeometry.ts` as single mm→dot owner, drivers own the paper envelope, sharpened
error taxonomy in `labelDispatch.ts`, `HardwareLabelTemplates.tsx` preview rescales
paper + content together.

**Phase 14 (close-out — this stream)**
- Step 6 — **Workflow bindings admin UI** landed in `src/components/hardware/WorkflowBindingsCard.tsx`, mounted as a new "Bindings" tab in `HardwareDevices.tsx`. CRUD against `printer_workflow_bindings` (workflow + printer profile + branch scope + priority), RLS-scoped (admin/owner writes, org reads). Workflow taxonomy list matches the DB `printer_workflow` enum and includes the "used by" hint copy required by Phase 17 step 17.
- Step 7 — **Test-print** button on the `label_printer` role card in `HardwareDevices.tsx` dispatches through `printLabelByTemplate` (workflow `product_tag`, template `product_label`) so the test exercises workflow binding + media resolution + driver pipeline in one shot. Success toast surfaces resolved media size, dpi, and template version.
- Step 9 — **Guardrail tests** landed:
  - `src/test/printing/media-geometry-single-owner.test.ts` — `mediaGeometry.ts` stays import-free; only the two drivers, browser adapter, and label editor consume it and none re-declare `dpi / 25.4`.
  - `src/test/printing/hardware-label-templates-editor.test.ts` was already in place (editor never imports pdf-lib / bwip-js / drivers).

**Phase 15 (D13 fix — media-relative body language)**
- Steps 4 & 5 — `renderTemplateBody` mm-token pre-pass (`{{mm:n}}`, `{{cf:n mm}}`, `{{bh:n mm}}`, `{{by:n mm}}`) keyed on resolved `media.dpi`; `label_templates.geometry_mode` column with `'mm' | 'dots-legacy'` and the seeded `product_label` rewritten in mm (`20260721005711`).
- Step 7 — `label-body-mm-scaling.test.ts` locks the fix at 152 / 203 / 300 dpi and multiple media sizes.

**Phase 16 (D14 fix — barcode identity)**
- Step 8 — `src/services/printing/labelBarcode.ts` with `resolveLabelBarcode(product)` returning `{ code, hri }` or `null`; UUIDs never returned.
- Step 9 — `src/pages/Products.tsx` uses the resolver + refusal toast + enrollment CTA.
- Step 10 — Templates now use `{{barcode}}` + `{{sku_display}}` + `{{hri_flag}}` tokens explicitly.
- Step 11 — ESLint rule `eslint-rules/no-product-id-as-barcode.js`, registered in `eslint.config.js`, with `src/test/printing/no-product-id-as-barcode.test.ts` (RuleTester at module top level for ESLint v9 / Vitest compatibility).
- Step 12 — `src/test/printing/label-barcode-policy.test.ts` + updated `products-label-print.test.ts` (refusal path + CTA).

**Phase 17 seam (partial — foundation only)**
- Step 16 — Migration `20260721021030_*.sql` seeds all seven canonical templates (`product_label`, `shelf_label`, `lot_label`, `bin_label`, `receiving_label`, `pallet_label`, `shipping_label`) per org, all `geometry_mode='mm'`, all `media_profile_id=NULL` (ADR-0087). Backfill trigger updated.
- Step 17 (partial — data side) — Workflow taxonomy + hints now surfaced by the Bindings tab; per-workflow "used by" copy is in `WorkflowBindingsCard.WORKFLOWS`.
- Shared caller seam — `src/hooks/inventory/useLabelPrint.ts` collapses barcode resolution + refusal + dispatch into a single `print({ templateKey, workflow, product, extraVars })` call.

**Phase 18 (documentation)**
- ADR-0088 (media-relative geometry) and ADR-0089 (barcode identity contract) published under `docs/adr/`.

### 🟡 Pending

**Phase 15 · step 6** — `HardwareLabelTemplates.tsx` needs the "Units" toggle (mm vs legacy-dots),
suspicious-integer warning banner for mm-mode bodies, and side-by-side previews at 152 / 203 / 300 dpi.
Currently the editor scales the preview but does not surface unit intent to authors.

**Phase 17 · steps 13–15, 18** — the per-page callers are not yet wired. Only `src/pages/Products.tsx`
uses `printLabelByTemplate`. Every other caller should route through `useLabelPrint`:
- **Inventory** — Product detail (batch Print label), Batches/lots (`lot_label`), Cycle count (`bin_label`).
- **Warehouse** — Receiving (`receiving_label`), Putaway (`pallet_label`), Shipping (`shipping_label`), Shelf-edge / price change (`shelf_label`).
- **POS** — Product tag reprint from item search modal (`product_label` + workflow `product_tag`), Price-change label from Change price dialog (`shelf_label` + workflow `shelf_edge`).
- Guardrail: `src/test/printing/label-coverage.test.ts` — for each of the 7 template keys, assert (a) a seed row exists (b) at least one UI file under `src/pages/` or `src/apps/` calls `printLabelByTemplate` (or `useLabelPrint`) with that key.

### 🔴 Known pre-existing (not owned by this stream)
- `src/test/hardware/electron-assignment-hydrator.test.ts` — timing-sensitive test around `startElectronAssignmentHydrator` that expects `upsert` twice but observes once. Unrelated to printing stream; flagged for the hardware-runtime owner.

## Next agent instructions

1. **Verify Phase 14 close-out first.**
   - Read `src/components/hardware/WorkflowBindingsCard.tsx` end-to-end and confirm:
     - No client-side privilege checks — RLS is the source of truth (`pwb_admin_write` policy).
     - Workflow enum list matches DB enum `printer_workflow` (10 values) and `PrinterWorkflow` in `src/services/printing/labelDispatch.ts`.
     - Priority semantics documented and enforced in the resolver (`resolve_workflow_printer`, lower wins).
   - Confirm `HardwareDevices.tsx` renders the new "Bindings" tab (`data-testid="tab-bindings"`) and the Test-print button on the `label_printer` role card still passes the media-resolution snapshot copy.
   - `bunx vitest run src/test/printing/ src/test/hardware/` should be green except for the known unrelated `electron-assignment-hydrator` failure.

2. **Then resume Phase 17, step 13 (Inventory callers).**
   - Use `useLabelPrint` — do NOT hand-roll a new fallback string. The ESLint rule `no-product-id-as-barcode` will fail any `.id` fallback.
   - Bind each caller to the correct workflow: Product detail → `product_tag`, Lots → `product_tag` (or a new dedicated workflow if operators demand it — coordinate before adding to the enum), Cycle count → `shelf_edge`.
   - Idempotency keys: include the source doc + line number so multi-print doesn't duplicate.

3. **Then Phase 17 step 14 (Warehouse) and step 15 (POS)** — same seam, same pattern.

4. **Close Phase 17 with step 18 (coverage test)** so future refactors can't quietly drop a caller.

5. **Then loop back to Phase 15 step 6 (editor Units toggle + multi-DPI preview).**

## Architectural invariants that MUST hold across all remaining work
- Every caller goes through `useLabelPrint` (or `printLabelByTemplate` directly with the barcode resolved via `resolveLabelBarcode`). No inline `product.id` fallbacks — ESLint enforces this.
- Template bodies stay engine-native (ZPL / EPL) but coordinates are mm tokens. Envelope stays owned by the driver.
- Workflow bindings live in `printer_workflow_bindings`; the runtime uses `resolve_workflow_printer` server-side. The admin UI is a thin CRUD surface only.
- New templates added to Phase 17 seeds must be `geometry_mode='mm'` and `media_profile_id=NULL` (ADR-0087).
- No new DPI math outside `mediaGeometry.ts` (`media-geometry-single-owner.test.ts` will fail otherwise).

## Definition of done (unchanged)
- 6 dpmm and 8 dpmm renders of `product_label` on the same 50×30 mm media both fit inside the media edges with the barcode fully visible.  ✅
- A product with no `barcode` and no `sku` produces a refusal toast + enrollment CTA — never a UUID under bars.  ✅
- Each of Inventory, Warehouse, POS has at least one shipping "Print label" action wired to `printLabelByTemplate` with the correct workflow key.  🟡 pending
- `bunx vitest run src/test/printing/ src/test/hardware/` green (excluding the known unrelated hydrator flake).  ✅ 22/23 test files
- ADR-0088 + ADR-0089 + D13/D14/D15 audit rows landed.  ✅
