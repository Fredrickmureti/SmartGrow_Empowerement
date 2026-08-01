# Project Memory

## Core
Certificate rendering is country-agnostic: engine ships only generic node primitives + a pack-owned Theme. No country/statute/regulator token may appear in `_shared/certificate-engine/*` or `src/features/localization/lib/engine/*`. Enforced by `certificate-engine.compile.test.ts`.

Certificate AST supports both v3 (matrix, identity_strip — legacy) and v4 (grid, list, label_fill, field_row, columns, page_break — statutory-form parity). Prefer v4 for new templates; keep v3 renderers alive for stored templates until a codemod migrates them.

Every visual choice (typography, rule weight, header shading, zebra) is expressed in `template.theme` (Theme). Engine CSS uses CSS custom properties; ENGINE_DEFAULT_THEME preserves the pre-v4 aesthetic for legacy templates.

Statutory paper allowlist covers A3/A4/Letter/Legal × portrait+landscape. Which paper is legal for a specific filing is pack metadata — not `_shared/pdf/index.ts`.

Localization previews (certificates AND statutory returns) resolve through `resolveReturnRenderer` / `resolvePopOutRenderer` in `src/features/localization/lib/preview/rendererRegistry.tsx`. No ad-hoc `switch` on submission_format outside the registry. `meta.outputs[]` is the ground truth for renderer selection; `submission_format.kind` is the legacy fallback. See ADR 0063.

pdf-lib is forbidden in localization preview/renderer code. Returns render through the certificate-engine `compile()` → paged.js pipeline via `buildReturnAstTemplate` (`src/features/localization/lib/preview/returnToAst.ts`). Enforced by ESLint `no-pdf-lib-in-localization-preview`. Server-side PDF for returns still uses `_shared/pdf/returnRenderer.ts` pending Cloudflare Browser Rendering.

Shared preview code (`components/preview/**`, `lib/preview/**`) is country-agnostic. The only sample fixture is `samplePayload.ts` (`SAMPLE_PAYROLL_ROWS`, `SAMPLE_RETURN_PAYLOAD`). Country-specific values come from `pack_token_registry.sample_value`. Enforced by ESLint `no-country-fixture-in-shared-preview`.

Tenant and admin edit templates through the SAME full-page shells (`CertificateEditorPage`, `ReturnEditorPage`); the only differences are the persistence adapter, legal-metadata edit rights, and publish vs override.

Product identity: ONE resolver. Client → `useResolveProductIdentity` (or `useWmsIdentityGate` in WMS); SQL → `resolve_product_identity`. Never query `product_identifiers` from a capture surface. Pack size = `product_packaging.qty_in_base_uom` only (`pack_quantity` / `packaging.barcode_id` dropped). See ADR 0102.

## Memories
- [Certificate rendering](mem://features/certificate-rendering) — Engine AST versions, node primitives, theme system, KE P9 blueprint mapping.
- [ESS identity portal](mem://features/ess-identity-portal) — Ownership matrix (HR vs identity vs employee-managed), change-request RPCs, /me/* shell integrity guards.
- [Product identification](mem://features/product-identification) — canonical resolver contract, level-aware labels, Phase D removals
