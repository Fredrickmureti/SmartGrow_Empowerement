## Problem

The certificate PDF renderer is hardcoded to **A4 portrait** (`PAGE_W = 210mm`, `CONTENT_W ≈ 511pt`). The KRA P9 monthly breakdown has 18 columns (Month + A, B, C, D, E1, E2, E3, F, G, H, I, J, K, L, M, N, O), leaving ~28pt per column — column headers wrap and overprint each other.

Both the official KRA P9 and Odoo's `l10n_ke` P9 report render in **A4 landscape** for this exact reason. Wide monthly-breakdown certificates need landscape; simple certificates (Certificate of Service, Annual Earnings Statement) stay portrait.

## Decision

Make page orientation a **template-level property** (like Odoo's `paperformat_id` on each QWeb report), not a global renderer constant. P9/P9A opt into landscape; every other certificate stays portrait.

## Changes

### 1. Renderer (both files — parity test enforces this)
`supabase/functions/_shared/pdf/certificateRenderer.ts` and `src/features/localization/lib/pdf/certificateRenderer.ts`:

- Replace the module-level `PAGE_W` / `PAGE_H` / `CONTENT_W` constants with a per-render `layout` object derived from `template.body.page` (default `{ size: "a4", orientation: "portrait" }`).
- When `orientation === "landscape"`, swap width/height (`PAGE_W = 297mm`, `PAGE_H = 210mm`).
- Thread `layout` through the render context so `addPage`, section drawers, page-footer, and totals all read from it instead of module constants.
- Update the parity-test `grab()` helper target: constants become `computeLayout(...)` — adjust `certificateRenderer-parity.test.ts` to compare the helper signature instead of raw constants.

### 2. Statutory paper guard
`supabase/functions/_shared/pdf/index.ts`:
- Widen the default `assertStatutoryPaper` allowlist for certificates to accept `"a4"` and `"a4-landscape"`. KRA's own P9 template is landscape, so landscape is compliant.
- Caller passes the resolved orientation-qualified string.

### 3. Schema — `certificate_template_v2`
Migration to extend the schema stored in `pack_rule_type_schemas`:
- Add optional `page` object at the body root: `{ size: enum["a4"], orientation: enum["portrait","landscape"] }`, default portrait.
- Backwards compatible: existing templates without `page` render portrait exactly as today.

### 4. Kenya P9 / P9A templates
Migration updating `localization_pack_certificate_templates` for `P9` and `P9A`:
- Set `body.page = { size: "a4", orientation: "landscape" }`.
- No other body changes — the 18-column monthly grid stays as-is; it just gets ~840pt of usable width instead of ~511pt (~44pt per column), which is what KRA's own template uses.

### 5. Publisher editor
`CertificateTemplateEditor.tsx`: add a small "Page" control (portrait/landscape radio) in the legal-metadata panel, writing to `body.page.orientation`. The live preview pane already re-renders on every body change, so publishers see the orientation flip immediately.

### 6. Docs
Append a short "Page orientation" section to `docs/adr/0060-certificate-template-parity.md` noting that orientation is template-owned metadata, parallel to Odoo's `paperformat_id`.

## Out of scope

- A3 or Letter support (no known statutory requirement).
- Per-section column-width tuning — the landscape width alone resolves the cramping; fine-tuning can wait until we see a real regeneration.
- Editable-XLSX twin: already width-agnostic (Excel columns auto-fit), no change needed.

## Verification

- Regenerate a Kenya P9 in the preview pane and confirm all 18 column headers render on one row without overlap.
- Run `certificateRenderer-parity.test.ts` and `certificate-template-v2-schema.test.ts`.
- Confirm Certificate of Service and Annual Earnings Statement still render portrait (no regressions on narrow templates).
