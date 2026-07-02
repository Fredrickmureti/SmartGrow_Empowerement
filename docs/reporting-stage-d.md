# Reporting Stage D — Deprecation of `TemplateSettings` styling fields

> **Status:** scoped, not executed. This document is the implementation brief
> for a future PR. Stage D is the only piece of the reporting consolidation
> plan that still touches the database; it is intentionally isolated from
> Stages A–K which are pure backend refactors.

## Objective

Remove the legacy "themeable document" surface from the platform. The unified
PDF engine (`_shared/pdf/*` + `_shared/pdf/themes/accountantMono.ts`) is the
single source of truth for visual style. The fields below are dead weight on
the type system, the database, and (worse) the UI — they expose users to
choices that have no effect on the rendered output.

## Fields to retire

### Database — `document_templates` columns

| Column            | Type    | Used by                                        |
|-------------------|---------|------------------------------------------------|
| `primary_color`   | text    | (read by 9 frontend files; ignored in PDF)     |
| `secondary_color` | text    | (read by frontend; ignored in PDF)             |
| `accent_color`    | text    | (read by frontend; ignored in PDF)             |
| `font_family`     | text    | (read by frontend; ignored in PDF)             |
| `font_size_base`  | integer | (read by frontend; ignored in PDF)             |
| `background_color`| text    | (read by frontend; ignored in PDF)             |
| `custom_css`      | text    | (read by frontend HTML preview — also dead)    |
| `logo_position`   | text    | always rendered top-left in unified PDF        |
| `logo_size`       | text    | unified PDF caps at 100×45 px regardless       |

### TypeScript types

`supabase/functions/_shared/templateRenderer.ts` →
`TemplateSettings` interface and `DEFAULT_TEMPLATE_SETTINGS` constant
(both currently include the fields above with hardcoded defaults).

`src/types/documentTemplate.ts` (frontend mirror).

### Frontend reads (must be deleted before the DB migration)

Search target: `primary_color|accent_color|font_family|secondary_color|background_color|custom_css`.
Confirmed call sites at the time of writing (Apr 2026):

1. `src/components/templates/PaymentMethodsSettings.tsx`
2. `src/components/templates/ReceiptSettings.tsx`
3. `src/components/pos/ReceiptDialog.tsx`
4. `src/components/pos/ReceiptPreviewDialog.tsx`
5. `src/components/templates/TemplateColorPicker.tsx` *(entire component deletable)*
6. `src/components/templates/TemplateFontPicker.tsx` *(entire component deletable)*
7. `src/components/templates/TemplatePreview.tsx`
8. `src/pages/DocumentTemplates.tsx`
9. `src/integrations/supabase/types.ts` *(auto-generated — regenerated after the migration)*

Note: counts may have shifted; re-run the grep before starting the PR.

## Why this hasn't shipped yet

1. **Production data:** Live tenants have populated these columns. A
   destructive migration without notice would erase customer customisation
   — even though that customisation has no visible effect.
2. **UI assumptions:** Several components branch on `primary_color`. They
   need to be either deleted (preferred) or rewritten to use semantic
   tokens before the columns can go.
3. **Scope:** Stage D is fundamentally a frontend + DB change. Bundling it
   with the backend funnel work (Stages A–K) would have inflated PR risk
   and made review impractical.

## Migration plan (three releases)

### Release 1 — stop writing

- Update `DocumentTemplates.tsx` and any `update`/`insert` call to omit
  the styling columns. Existing values remain untouched.
- Hide the colour/font picker UI. Replace with a banner: "Document styling
  is now managed centrally for accountant-grade consistency."

### Release 2 — stop reading

- Delete the 9 frontend files / branches above.
- Drop the fields from `TemplateSettings` (TS interface) and
  `DEFAULT_TEMPLATE_SETTINGS`. Drop the legacy block at the bottom of
  `templateRenderer.ts`.

### Release 3 — drop columns

- DB migration:
  ```sql
  ALTER TABLE public.document_templates
    DROP COLUMN primary_color,
    DROP COLUMN secondary_color,
    DROP COLUMN accent_color,
    DROP COLUMN font_family,
    DROP COLUMN font_size_base,
    DROP COLUMN background_color,
    DROP COLUMN custom_css,
    DROP COLUMN logo_position,
    DROP COLUMN logo_size;
  ```
- Regenerate `src/integrations/supabase/types.ts`.
- Smoke-test PDF generation across all 12 document types.

## Adjacent cleanup that should ride with Stage D

The 12 `fetch<DocType>` functions in `supabase/functions/generate-document/index.ts`
(invoice, estimate, proforma, credit_note, purchase_order, receipt,
pos_receipt, sales_order, delivery_note, sales_return, customer_statement,
vendor_statement, bill — total ~700 LoC) are mechanically similar. They
should be replaced by a single config-driven fetcher:

```ts
const FETCH_CONFIG: Record<DocumentType, FetchConfig> = {
  invoice: {
    table: "invoices",
    select: "...",
    itemsTable: "invoice_items",
    numberField: "invoice_number",
    map: (row) => ({ /* DocumentData shape */ }),
  },
  // ...
};
```

Estimated saving: ~500 LoC, one canonical place to add a new document
type. Out of scope for the backend funnel work — belongs with Stage D.

## What this PR does NOT propose

- No new visual styling. The accountant-mono theme is the answer.
- No new colour palette knobs. Branding is logo + company name + address —
  nothing else.
- No HTML preview revival. The HTML branch was deleted in Stage G.

## Acceptance criteria

A successful Stage D ships when:

1. Live PDF output is byte-identical (or visually identical) to today's.
2. No frontend file references `primary_color` / `accent_color` /
   `font_family` / `secondary_color` / `background_color` / `custom_css`.
3. `document_templates` no longer has those columns in production.
4. The snapshot tests in `_shared/__tests__/reportPdfGenerator.snapshot.test.ts`
   still pass.
