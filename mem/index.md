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

Identity resolution returns a DECISION (resolved/ambiguous/not_found/inactive/archived/expired/foreign_tenant/unauthorized). Operator copy comes only from `identityOutcome.ts`; SKU fallback is opt-in for typing paths.

Scanning has two device modes: handheld (own camera → scanBus in-process) and companion (paired phone). Never make a phone pair to itself. ADR 0107.

A `WorkspaceNav` may only be replaced when crossing an `AppDefinition`. Inside one app, navigation expands via `WorkspaceNavItem.children`. ADR 0101.

Warehouse side panes are read-only `EntityPreview` peeks; editing/config/history lives on `EntityWorkspaceShell` routes. ADR 0122.

Warehouse nav is domain-oriented (Work/Inbound/Inventory control/Outbound/Yard/Workforce/Analysis/Configuration-last); new surfaces attach inside a domain, depth<=2, group<=8. ADR 0121.

Any writer inserting `journal_entry_lines` MUST stamp organization_id, business_id and branch_id from the parent entry — they are NOT NULL and validated, not backfilled by the match trigger. Only the three posting-engine functions may insert journal lines (ADR 0123).

Credit notes, customer credit and refunds are server-side services (ADR 0131): no client-built JE lines, customer credit lives in `customer_credit_balances`/`_movements`, one refund engine (`refund_customer_atomic`), business-scoped locked numbering.



PDF typography is profile-based: `document` (transactional, frozen = legacy theme) vs `statement`/`ledger`/`operational` (reports). Profiles are opt-in in `generateReportPdf`; only `renderReport` selects one.

One report masthead for every report (PDF + screen): logo left, entity block left, title/period right. `formatProfile` drives wording/typography only, never header layout.

## Memories
- [Report masthead](mem://features/report-masthead-single-layout) — single operational masthead for all reports; redeploy render-report + process-scheduled-reports after PDF changes
- [Certificate rendering](mem://features/certificate-rendering) — Engine AST versions, node primitives, theme system, KE P9 blueprint mapping.
- [ESS identity portal](mem://features/ess-identity-portal) — Ownership matrix (HR vs identity vs employee-managed), change-request RPCs, /me/* shell integrity guards.
- [Product identification](mem://features/product-identification) — canonical resolver contract, level-aware labels, Phase D removals
- [Product identity decisions](mem://features/product-identity-decisions) — decision envelope statuses, lifecycle columns, outcome copy taxonomy, write-through RPCs
- [Scanner device modes](mem://features/scanner-device-modes) — handheld vs companion, single camera engine, LocalScanOverlay, /wm scan button contract
- [Workspace nav architecture](mem://features/workspace-nav-architecture) — ADR 0101 nav/app coherence rule, Employees nav composition, guard tests
- [Warehouse nav IA](mem://features/warehouse-nav-ia) — ADR 0121 domain groups, execution vs configuration split, depth/size caps, WMS terminology
- [Warehouse preview vs workspace](mem://features/warehouse-preview-vs-workspace) — ADR 0122 EntityPreview/EntityWorkspaceShell contract, which entities get workspace routes, ?sel/?tab conventions
- [Business reversal architecture](mem://features/business-reversal-architecture) — canonical reversal writers, journal line scope invariant, paid-invoice policy, per-domain gaps
- [Payment reversal](mem://features/payment-reversal) — ADR 0012 intent model, ReversePaymentWizard, atomic reversal RPCs, customer deposits
- [Commercial compensation](mem://features/commercial-compensation) — ADR 0131 credit notes, customer credit ledger, single refund engine, credit-note numbering rules
- [PDF presentation profiles](mem://features/pdf-presentation-profiles) — report vs document PDF type sizes, shrink floors, margins, opt-in rules
- [Statement line kinds](mem://features/statement-line-kinds) — canonical row-kind vocabulary and typography for all financial statements (screen + PDF)
