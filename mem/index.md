# Project Memory

## Core
Certificate rendering is country-agnostic: engine ships only generic node primitives + a pack-owned Theme. No country/statute/regulator token may appear in `_shared/certificate-engine/*` or `src/features/localization/lib/engine/*`. Enforced by `certificate-engine.compile.test.ts`.

Certificate AST supports both v3 (matrix, identity_strip — legacy) and v4 (grid, list, label_fill, field_row, columns, page_break — statutory-form parity). Prefer v4 for new templates; keep v3 renderers alive for stored templates until a codemod migrates them.

Every visual choice (typography, rule weight, header shading, zebra) is expressed in `template.theme` (Theme). Engine CSS uses CSS custom properties; ENGINE_DEFAULT_THEME preserves the pre-v4 aesthetic for legacy templates.

Statutory paper allowlist covers A3/A4/Letter/Legal × portrait+landscape. Which paper is legal for a specific filing is pack metadata — not `_shared/pdf/index.ts`.

## Memories
- [Certificate rendering](mem://features/certificate-rendering) — Engine AST versions, node primitives, theme system, KE P9 blueprint mapping.
