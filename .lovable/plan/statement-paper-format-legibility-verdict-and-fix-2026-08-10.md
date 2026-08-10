# Statement paper format & legibility — verdict and fix

## Verdict: confirmed, measured, not assumed

I measured the exact PDF you attached (glyph-level, `pdfplumber`), not a re-render:

| Measurement | Value |
| --- | --- |
| Page | A4 **portrait**, 595.3 x 841.9 pt |
| Body type (ledger rows) | **7.5 pt** (806 glyphs) — the largest share of the page |
| Smallest type on page | **7.0 pt** |
| Ink extent | x = 72.0 → 527.2 pt |
| Unused horizontal paper | 72 pt left + 68 pt right = **140 pt (23% of the sheet)** |
| Ledger columns | 7 (Date, Type, Reference, Description, Charges, Credits, Balance) |
| Rows | 12 transactions + opening + closing, on 1 page |

So your read was right on both counts: the body really is 7.5 pt (near the 6 pt
floor you guessed), and the layout is cramped. Two hard pieces of evidence that
it is cramped by configuration, not by content:

1. Cells wrap even though 140 pt of paper is left blank. In the extracted text,
   `Aug 10, 2026` breaks across two lines as "Aug 10," / "2026", and `credit
   application` breaks as "credit" / "application" — twice. A 7-column ledger
   was squeezed into 455 pt of the 595 pt sheet.
2. Only 14 rows are on the page. Density is not the constraint; the column
   widths and the 1-inch gutters are.

## Root cause

The typography work in `docs/audit/2026-08-08-report-typography.md` created four
presentation profiles (`document` 7.5pt / `statement` 10pt / `ledger` 8.5pt at
40pt gutter / `operational` 9pt). But those profiles are resolved in exactly one
place — `_shared/reports/renderReport.ts`, the analytical report funnel. That is
where the general ledger you're comparing against gets its landscape + 8.5pt +
40pt-gutter treatment.

A customer statement is not rendered there. `generateStatementPdf` in
`_shared/pdfGenerator.ts` is part of the transactional-document funnel: it
hard-codes `orientation: "portrait"`, and it calls `drawDataTable` with **no
typography argument**, so `DataTable.ts` falls back to `DOCUMENT_TYPOGRAPHY`
(7.5 pt body, 72 pt gutter, 6 pt shrink floor).

That is the defect: a statement is structurally a ledger (7 columns, running
balance, aging) but is typeset with invoice constants because of which funnel it
happens to sit in. The 2026-08-08 audit even names statements as untouched —
that exclusion was correct for invoices and wrong for statements.

## Fix

Treat customer and vendor statements as ledgers for presentation only. No change
to data, routing, dispatch, or any invoice.

1. **Landscape A4 + ledger profile for statement rendering.**
   `generateStatementPdf` renders `orientation: "landscape"` and resolves the
   `ledger` typography profile (8.5 pt body, 9 pt headers, 16 pt rows, 40 pt
   gutter, 7.5 pt shrink floor), threading it into the branded header, data
   table, summary block, totals block and footer — the same argument path
   `renderReport` already uses.
   Content width goes 451 pt → 762 pt (+69%), which absorbs the larger type and
   ends the cell wrapping.
2. **Rebalance the 7 column widths** for the wider canvas: give Date and Type
   enough width that a formatted date and `credit application` never wrap, and
   let Description take the slack.
3. **Paper-format respect.** Keep honouring an explicit `paperFormat`/policy
   override (thermal statements stay narrow and portrait); landscape A4 becomes
   the default only when nothing is pinned, and statements are already excluded
   from the statutory A4-pin list in ADR-0008.
4. **Guards.** Extend the existing typography test suite: statement kinds must
   resolve the `ledger` profile, must never render below 8.5 pt body type, and
   the `document` profile must stay byte-identical for invoices (the existing
   assertion stays green, proving no invoice reformats).
5. **Prove it on your data.** Re-render this exact statement snapshot from the
   real ledger rows and re-measure: assert landscape geometry, 8.5 pt minimum
   body glyphs, zero wrapped date/type cells, and still one page.

## Technical notes

- Edit surface: `supabase/functions/_shared/pdfGenerator.ts`
  (`generateStatementPdf` only), plus passing `typography` through the
  `_shared/pdf/components/*` calls it makes — every one of those components
  already accepts an optional `typography` and defaults to `document`.
- `PdfBuilder` already supports `orientation: "landscape"` and a `margin`
  override, so the ledger gutter needs no builder change.
- `inferPresentationProfile` already grades a 7-column financial table to
  `ledger`; statements just need to consult it.
- Verification harness: the local Deno render script used earlier in this audit,
  fed the frozen snapshot for statement `91914727…`, then measured with
  `pdfplumber`.
