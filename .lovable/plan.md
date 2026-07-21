
# Enterprise Printing Architecture — Continuation Plan

## Phase 1 verification (what the previous agent got right, and what's still broken)

Walked the codebase against `.lovable/plan.md` and ADR-0085/0086/0087.

**Landed and genuinely correct**
- Ownership matrix (ADR-0085) is enforced by 4 ESLint rules + runtime mirror tests.
- `label_templates` + `media_profiles` + hardware-shaped `printer_profiles` schema is in place with the 5-tier `resolve_label_template` resolver and the media-agnostic default seed (migration `20260721005711`).
- `mediaGeometry.ts` is the single mm→dot owner; `ZplLabelDriver`, `EplLabelDriver`, `BrowserHardwareAdapter` and the preview canvas all delegate to it.
- Drivers own the paper envelope (`^PW`/`^LL`, `q`/`Q`) and strip any envelope tokens embedded in the template body — geometry never rides in the template.
- `labelDispatch.ts` has the sharpened error taxonomy and the 4-step media fallback (override → printer pin → org default → any active).
- `HardwareLabelTemplates.tsx` at `/platform/hardware/labels` uses `mmToCssPx` so paper AND content rescale together in the preview.

**Genuinely pending from `.lovable/plan.md` Phase 14**
- Step 6 — "Bind to workflow" action on the printer detail sheet in `HardwareDevices.tsx`.
- Step 7 — "Test print" button on the same sheet.
- Step 9 — guardrail tests (`hardware-label-templates-editor.test.ts`, `media-geometry-single-owner.test.ts`).

**New architectural defects surfaced by the user's report (not covered by any prior phase)**

D13 — **Content isn't media-relative.** The seeded `product_label` body hard-codes dot coordinates (`^FO20,20`, `^CF0,28`, `^BY2,2,80`, `^BCN,80,…`). Drivers correctly scale the envelope with DPI (203→152dpi shrinks `^PW`/`^LL`), but the content stays at fixed absolute dots, so at 6 dpmm the paper shrinks in dots while the content does not → the barcode overruns the right edge and is clipped. At 8 dpmm the paper is larger in dots than the content, so it looks fine. Root cause: template bodies express geometry in device dots instead of physical millimetres. Enterprise systems (SAP Smart Forms, Zebra ZebraDesigner, LS Central) always express label layout in mm and let the renderer resolve dots per device.

D14 — **UUID leaks onto barcodes as an HRI fallback.** `src/pages/Products.tsx` computes `code = product.barcode || product.sku || product.id` and passes that as `{{barcode}}`. When neither `barcode` nor `sku` is set (the reported "Lemonade" case), `product.id` — a UUID — is encoded Code128 with `HRI = Y`, so the raw UUID string prints as human-readable characters under the bars. This isn't a rendering bug, it's a business-rule bug: an item with no assigned GTIN/SKU must not silently print an internal DB identifier.

D15 — **Label print seam is wired to exactly one caller.** Only `src/pages/Products.tsx` calls `printLabelByTemplate`. Warehouse (receiving, putaway, shelf-edge), POS (product tag / price change), Inventory (adjustments, cycle count, batches with lot/expiry) all lack a "Print label" action, even though the workflow taxonomy already lists `receiving`, `shipping`, `shelf_edge`, `product_tag`, and the dispatcher already accepts `lotNumber` / `expiryDate` / `manufactureDate`. This is coverage debt, not a redesign.

## Plan

### Phase 14 close-out (finish the previous agent's residual work)

1. **Bind-to-workflow** on `HardwareDevices.tsx` printer detail — canonical Records dialog, inserts into `printer_workflow_bindings` (org/branch/warehouse scope), admin/owner only.
2. **Test-print** on the same sheet — calls `printLabelByTemplate({ templateKey: 'product_label', workflow: 'product_tag', vars: { name: 'Test', sku: 'TEST-000', barcode: '000000000000' } })`, surfaces resolved template/printer/media/bytes count in a result drawer.
3. **Guardrail tests** — `hardware-label-templates-editor.test.ts` (editor imports `renderTemplateBody`, no `pdf-lib`/`bwip-js`/driver imports) and `media-geometry-single-owner.test.ts` (drivers + preview import from `mediaGeometry`).

### Phase 15 — Media-relative label body language (D13)

The renderer must own dot conversion for content, not just for paper. Two options were considered; the plan adopts option B because it doesn't require a per-template migration and stays inside the existing engine contracts.

- **Option A (rejected)** — invent an intermediate "label layout AST" (mm-based JSON), compile to ZPL/EPL/PDF. Powerful but forces re-authoring every existing body and duplicates the receipt Line[] AST at another abstraction level.
- **Option B (adopted)** — introduce **mm-unit tokens** inside existing engine bodies: `{{mm:20}}`, `{{cf:3.5mm}}`, `{{bh:10mm}}`, `{{by:0.25mm}}`. `labelDispatch.renderTemplateBody` resolves these against the resolved `media.dpi` before the body reaches the driver. Templates stay ZPL/EPL, but coordinates and sizes are physical.

Steps:
4. Extend `renderTemplateBody` with an mm-token pre-pass keyed on `media.dpi`. Add a strict mode that rejects raw two-digit numbers next to `^FO` / `^CF` / `^BY` / `^B*,h` when authored in the new editor (opt-in per template via `label_templates.geometry_mode = 'mm' | 'dots-legacy'`).
5. Migration: add `geometry_mode text not null default 'dots-legacy'` to `label_templates`; the seeded `product_label` gets a new default body authored in mm and `geometry_mode='mm'`:
   `^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:3}}^FD{{name}}^FS^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:8}}^FD{{sku_display}}^FS^BY{{by:0.33mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:14}}^BCN,{{bh:10mm}},{{hri_flag}},N,N^FD{{barcode}}^FS^XZ`
   Content now scales with dpi.
6. Editor: `HardwareLabelTemplates.tsx` gains a "Units" toggle (mm vs legacy-dots), a live warning when a mm-mode body contains suspicious integer coordinates, and preview at multiple dpis (152/203/300) side-by-side so authors see the physical output before saving.
7. Tests:
   - `label-body-mm-scaling.test.ts` — same body at 152/203/300 dpi produces envelope+content that fits inside `^PW`/`^LL` in every case (fuzz across 3 media sizes).
   - `label-body-dots-legacy-untouched.test.ts` — `geometry_mode='dots-legacy'` bodies pass through unchanged (backwards compat).

### Phase 16 — Barcode identity policy (D14)

8. Introduce `resolveLabelBarcode(product, options)` in `src/services/printing/labelBarcode.ts` with a strict contract:
   - Return `{ code, hri }` where `hri = 'Y' | 'N'`.
   - Priority: `product.barcode (validated GTIN/EAN/UPC/Code128 payload) → product.sku (non-empty, printable) → null`.
   - **Never** returns `product.id`.
9. `Products.tsx`, and every future caller, replace the inline `code || sku || id` fallback with `resolveLabelBarcode(product)`. When it returns `null`:
   - Refuse to dispatch. Toast: "This product has no barcode or SKU assigned. Add one in Product → Identifiers, or enroll via the barcode workflow."
   - Offer a one-click "Open barcode enrollment" CTA that routes to the existing enrollment flow (`mem/features/barcode-enrollment.md`).
10. Template exposes two tokens instead of one: `{{barcode}}` (encoded payload) and `{{sku_display}}` (human line under the bars). `hri_flag` becomes a token so the template controls whether the barcode's own HRI prints (default `N`) — the human line is authored explicitly with `sku_display`.
11. ESLint rule `no-product-id-as-barcode.js` — flags any string literal or expression that ORs a `.id` field into a `printLabelByTemplate` `barcode` var.
12. Tests:
    - `label-barcode-policy.test.ts` — priority order, refusal semantics, UUID never returned.
    - Update `products-label-print.test.ts` to assert the refusal path and CTA.

### Phase 17 — Coverage across Inventory / Warehouse / POS (D15)

Every canonical label use case gets a real caller. Each is a thin UI-layer addition — the pipeline itself does not change.

13. **Inventory**
    - Product detail: "Print label" batch action honouring qty (respects `printLabelByTemplate` idempotency).
    - Batches/lots page: "Print lot label" using `templateKey='lot_label'` with `lotNumber`/`expiryDate`/`manufactureDate` populated (dispatcher already supports these).
    - Cycle count: "Print bin recount label" using `templateKey='bin_label'`, workflow `shelf_edge`.
14. **Warehouse**
    - Receiving: "Print receipt label" per line on GRN using `templateKey='receiving_label'`, workflow `receiving`. Vars include PO/GRN number, supplier, dock.
    - Putaway: "Print putaway pallet label" using `templateKey='pallet_label'`, workflow `receiving`.
    - Shipping: "Print shipping label" using `templateKey='shipping_label'`, workflow `shipping`. Address block token pack.
    - Shelf-edge / price change: "Print shelf label" using `templateKey='shelf_label'`, workflow `shelf_edge`, includes price token.
15. **POS**
    - Product tag reprint from the item search modal — same `product_label` template but workflow `product_tag`, so branches can bind a different physical printer than the back office.
    - Price-change label from the "Change price" dialog, workflow `shelf_edge`.
16. **Seeds** — one migration that inserts the missing default templates (`lot_label`, `bin_label`, `receiving_label`, `pallet_label`, `shipping_label`, `shelf_label`) per org, all `geometry_mode='mm'`, all `media_profile_id = NULL` (ADR-0087). Backfill trigger updated to insert them for new orgs.
17. **Workflow binding UX** — the Bind-to-workflow dialog from Phase 14 step 1 now enumerates the full workflow taxonomy above with a short "used by" hint under each option, so operators can bind a Zebra to `receiving` and a receipt-style label printer to `product_tag` independently.
18. **Tests**
    - `label-coverage.test.ts` — for each of the 7 template keys, assert (a) a seed row exists, (b) at least one UI file calls `printLabelByTemplate` with that key.
    - `no-inline-barcode-fallback.test.ts` — enforces D14 refusal contract across all callers.

### Phase 18 — Documentation

19. **ADR-0088 — Label geometry is media-relative.** Records D13, the mm-token language, `geometry_mode` column, and the driver contract that content resolution now happens in `labelDispatch` (envelope resolution stays in drivers).
20. **ADR-0089 — Barcode identity contract.** Records D14 and the `resolveLabelBarcode` policy.
21. Append D13/D14/D15 rows to `docs/audit/2026-07-20-enterprise-output-platform.md` with closure dates and the guardrail tests that lock the fix in.

## Technical notes

- The mm-token pre-pass is a pure string transform driven by `media.dpi`; it runs in `renderTemplateBody` before the driver sees the body. Drivers keep their current contract (bytes/zpl in, wire bytes out) — no driver churn.
- `geometry_mode` defaults to `'dots-legacy'` so every existing body (including operator-authored ones) prints identically until an operator opts in from the editor. The seeded `product_label` gets rewritten to `'mm'` in the same migration that introduces the column.
- `resolveLabelBarcode` returns `null` — not a fallback string — because printing a UUID as a scannable barcode is worse than not printing at all. The CTA to enrollment closes the workflow loop.
- All new callers reuse the existing `printLabelByTemplate` + `useInventoryLabelPrinter` missing-device CTA seam. No new hardware pipelines, no new drivers.
- Workflow-bound printer resolution already supports branch + warehouse scoping, so multi-org / multi-branch tenants (the "Walmart-size" case) don't need any additional schema.

## Definition of done

- 6 dpmm and 8 dpmm renders of `product_label` on the same 50×30 mm media both fit inside the media edges with the barcode fully visible.
- A product with no `barcode` and no `sku` produces a refusal toast and enrollment CTA — never a UUID under bars.
- Each of Inventory, Warehouse, POS has at least one shipping "Print label" action wired to `printLabelByTemplate` with the correct workflow key.
- `bunx vitest run src/test/printing/ src/test/hardware/` green, including the new mm-scaling, barcode-policy, and coverage tests.
- ADR-0088 + ADR-0089 + D13/D14/D15 audit rows landed.
