# ADR-0089 — Barcode identity contract

- Status: Accepted (2026-07-21)

> **Superseded in part by [ADR 0114](./0114-product-identity-and-resolution.md)** (2026-08-05):
> the decision envelope, the single read/write client seams, supplier-scoped
> identifiers and the authenticated-only identity surface replace the
> resolution rules described below. The labelling rules that ADR 0114 does
> not restate remain in force.

- Related: ADR-0085 (rendering ownership), ADR-0088 (media-relative
  geometry), `mem/features/barcode-enrollment.md`

## Context

`src/pages/Products.tsx` used to compute:

```ts
const code = product.barcode || product.sku || product.id;
```

and pass `code` into the `{{barcode}}` template variable. When neither
`barcode` nor `sku` was set — the reported "Lemonade" case — the
fallback ran, so `product.id` (a UUID) was encoded Code128 and printed
with the HRI line switched on. Scanners on the shop floor scanned the
label back into the ERP and got a value that no product lookup will
ever match, and the human-readable line under the bars was a raw
database identifier that leaks internal state.

Internal identifiers must never appear on a shop-floor label. Every
enterprise POS/WMS/ERP (SAP, Oracle Retail, LS Central, NCR) enforces
this at the barcode-render seam.

## Decision

A single service, `src/services/printing/labelBarcode.ts`, owns the
policy. Contract:

```ts
resolveLabelBarcode(product) → { code, hri, skuDisplay } | null
```

- `code`: `product.barcode → product.sku → null`.
  **UUIDs, bigints, and other internal IDs are never returned.**
- `hri`: always `'N'`. The human line under the bars is authored
  explicitly with the `{{sku_display}}` token so it can carry SKU,
  price, size, batch, etc. without polluting the encoded payload.
- `skuDisplay`: the SKU when set, otherwise `''`. Never `product.id`.

Callers MUST use this service. When it returns `null` the UI MUST
refuse to dispatch and route the operator to barcode enrollment.
`LABEL_BARCODE_REFUSAL` supplies the canonical toast copy.

## Consequences

- Products with no assigned barcode/SKU can no longer produce a
  scannable-but-useless UUID label.
- Every label caller shares one refusal path, so the enrollment CTA is
  consistent across Inventory, Warehouse, POS.
- Template authors control the human line separately from the encoded
  payload — a shelf label can show a formatted price without inflating
  the barcode.

## Guardrails

- `src/test/printing/label-barcode-policy.test.ts` — priority order,
  refusal semantics, UUID never returned, `skuDisplay` never leaks
  from `product.id`.
- `src/pages/Products.tsx` calls `resolveLabelBarcode` and surfaces
  `LABEL_BARCODE_REFUSAL` on `null`.
