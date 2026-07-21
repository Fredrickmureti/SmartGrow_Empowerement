
# Enterprise Printing — Continuation & Coverage Plan

## Where things actually stand (verified, not just claimed)

I read `.lovable/plan.md` end-to-end and spot-checked the codebase to confirm the previous engineer's status claims before deciding what still needs doing.

**Verified present in the codebase:**
- Ownership matrix (ADR-0085) + guardrails (`no-raw-pdf-lib-in-app`, `no-direct-barcode-lib`, `no-raw-zpl-outside-printing`, `no-raw-escpos-bytes`, `no-printservice-shim`, `no-product-id-as-barcode`).
- Single mm→dot math owner: `src/services/printing/mediaGeometry.ts` + guardrail test `media-geometry-single-owner.test.ts`.
- Drivers own the paper envelope: `electron/hardware/drivers/ZplLabelDriver.ts`, `EplLabelDriver.ts`, `EscPosLabelDriver.ts`.
- `label_templates`, `media_profiles`, `printer_profiles` (hardware-shaped), `printer_workflow_bindings` + `resolve_workflow_printer` RPC (`supabase/migrations/20260617133303_*.sql`).
- Seven canonical templates seeded `geometry_mode='mm'`, `media_profile_id=NULL` (`20260721021030_*.sql`).
- Barcode identity resolver `src/services/printing/labelBarcode.ts` + refusal-toast + enrollment CTA in `src/pages/Products.tsx`.
- Shared caller seam `src/hooks/inventory/useLabelPrint.ts`.
- Admin surface `src/components/hardware/WorkflowBindingsCard.tsx` mounted as the `data-testid="tab-bindings"` tab in `src/apps/platform/hardware/HardwareDevices.tsx`, plus the label-printer test-print button.
- ADR-0088 (media-relative geometry), ADR-0089 (barcode identity) published.
- 17 printing test files under `src/test/printing/` cover envelope parity, media requirement, mm-scaling at 152/203/300 dpi, product-id-as-barcode policy, ZPL/kitchen goldens.

**Verified genuinely pending** (only `src/pages/Products.tsx` currently calls `printLabelByTemplate` — no other pages or apps do):
- Phase 15 · step 6 — editor Units toggle + multi-DPI preview + suspicious-integer warning.
- Phase 17 · steps 13–15 — Inventory / Warehouse / POS caller wiring.
- Phase 17 · step 18 — coverage guardrail test.

**Known-unrelated (out of scope):** `src/test/hardware/electron-assignment-hydrator.test.ts` flake — owned by the hardware-runtime stream, not printing.

## Plan (in execution order)

### 1. Independent verification pass (no code changes)

Before wiring any callers, re-read the four foundation files end-to-end and run the printing test suite to confirm the reported green state:
- `src/services/printing/labelDispatch.ts` — confirm `printLabelByTemplate` signature, workflow taxonomy, error taxonomy.
- `src/hooks/inventory/useLabelPrint.ts` — confirm the `{ templateKey, workflow, product, extraVars, idempotencyKey }` shape and that it internally calls `resolveLabelBarcode` (refusal path) and surfaces the missing-device CTA.
- `src/components/hardware/WorkflowBindingsCard.tsx` — confirm workflow enum list matches DB `printer_workflow` and priority semantics (lower wins) match `resolve_workflow_printer`.
- Run `bunx vitest run src/test/printing/ src/test/hardware/` and record the exact set of failures. Any new failure beyond the hydrator flake blocks the wiring phase until fixed.

### 2. Phase 17 · step 13 — Inventory callers

Route each Inventory "Print label" surface through `useLabelPrint`. No inline ZPL, no `product.id` fallbacks, no direct `hardwareClient` reach-around.

| Surface | File | Template key | Workflow | Idempotency key |
|---|---|---|---|---|
| Product detail — batch Print label | `src/pages/inventory/…/ProductDetail*.tsx` (locate via `rg`) | `product_label` | `product_tag` | `product:{id}:v{version}` |
| Batches / Lots — Print lot label | Lots page | `lot_label` | `product_tag` | `lot:{lotId}` |
| Cycle count — bin re-label | Cycle-count screen | `bin_label` | `shelf_edge` | `bin:{binId}:{countSessionId}` |

Each caller: missing-device CTA linking to `/platform/hardware/devices`, refusal toast when `resolveLabelBarcode` returns null, structured `{ success, error }` result surfaced to the user.

### 3. Phase 17 · step 14 — Warehouse callers

| Surface | Template | Workflow |
|---|---|---|
| Receiving — print received-line label | `receiving_label` | `goods_receipt` |
| Putaway — pallet label on move | `pallet_label` | `putaway` |
| Shipping — carton / shipping label | `shipping_label` | `ship` |
| Shelf-edge / price change | `shelf_label` | `shelf_edge` |

Same seam, same refusal + CTA rules, idempotency keys derived from the source doc + line number so re-print doesn't duplicate physical labels.

### 4. Phase 17 · step 15 — POS callers

| Surface | Template | Workflow |
|---|---|---|
| Item-search modal — reprint product tag | `product_label` | `product_tag` |
| Change-price dialog — new shelf-edge label | `shelf_label` | `shelf_edge` |

POS must not import a new driver or open a new hardware pathway — everything routes through `useLabelPrint` so POS shares the exact same rendering + resolution pipeline as Inventory and Warehouse.

### 5. Phase 17 · step 18 — coverage guardrail

Add `src/test/printing/label-coverage.test.ts` (source-inspection style — the pattern used by `products-label-print.test.ts`):

For each of the 7 canonical template keys (`product_label`, `shelf_label`, `lot_label`, `bin_label`, `receiving_label`, `pallet_label`, `shipping_label`) assert:
1. A seed row exists in `20260721021030_*.sql`.
2. At least one file under `src/pages/**` or `src/apps/**` invokes `printLabelByTemplate` or `useLabelPrint` with that key.

This is the guard that prevents future refactors from silently dropping a caller.

### 6. Phase 15 · step 6 — Editor UX for mm geometry

`src/apps/platform/hardware/HardwareLabelTemplates.tsx`:
- **Units toggle** — segmented control `mm | dots (legacy)` bound to `label_templates.geometry_mode`. Warn when switching a saved template.
- **Suspicious-integer banner** — in mm mode, if the body contains bare integer coordinates ≥ 50 outside `{{mm:n}}` / `{{cf:n mm}}` / `{{bh:n mm}}` / `{{by:n mm}}` tokens, show an inline warning: "Looks like raw dots — this template is in mm mode."
- **Multi-DPI preview strip** — side-by-side render at 152 / 203 / 300 dpi against the currently selected media, so authors see mm-relative correctness at a glance.

No new DPI math anywhere — every conversion goes through `mediaGeometry.ts`.

### 7. Close-out

- Update `.lovable/plan.md` to move Phase 15 · step 6 and Phase 17 · steps 13–15 + 18 to `✅ Fully implemented and verified`.
- Run `bunx vitest run src/test/printing/ src/test/hardware/` — expect green minus the known hydrator flake.
- Verify all four guardrail ESLint rules still pass on the new caller files (no raw ZPL, no `product.id` barcode, no print-service shim, no raw ESC/POS).

## Architectural invariants that MUST hold across every change

- All label prints originate at `useLabelPrint` → `printLabelByTemplate` → `resolve_workflow_printer` → driver. No page constructs bytes.
- Barcode identity comes only from `resolveLabelBarcode`; a missing barcode produces a refusal + enrollment CTA, never a UUID.
- Template bodies remain engine-native (ZPL/EPL/ESC-POS) but coordinates are mm tokens; paper envelope is owned by the driver, never by the template.
- mm→dot math lives in `mediaGeometry.ts` only.
- Workflow bindings are DB-driven (`printer_workflow_bindings`); UI is a thin CRUD surface, resolution is server-side.

## Explicitly out of scope

- Rewriting the receipt / PDF pipelines (ADR-0084/0085 already govern these and the audits closed clean).
- The Electron assignment-hydrator flake (owned by hardware-runtime stream).
- Adding new workflows to the `printer_workflow` enum — coordinate first if operators demand a dedicated one for lots or cartons.
- Any new hardware transports or driver types.

## Technical details

- `useLabelPrint` result shape must stay `{ success: boolean; error?: string; missingDeviceCta?: { href: string; label: string } }` so callers render consistent toasts.
- Idempotency keys are passed through to the print job so a re-open of the same document does not double-print.
- New callers must import `useLabelPrint` from `@/hooks/inventory/useLabelPrint` — not from a POS hook, not from `hardwareClient`. The path name is legacy; the hook is cross-module.
- Coverage test uses `readFileSync` + regex (same pattern as `products-label-print.test.ts`) — no React render, no Supabase.
- Editor multi-DPI preview must call the same `mediaDots(...)` helper the drivers use so preview drift is impossible.
