# Sales Document Workspace — Audit Findings and Consolidation Plan

## What I verified in the code

The workspace pattern (list → peek drawer → full page) already exists, and a
previous pass extracted a shared layer at `src/features/sales/record/`:
`SalesRecordScaffold`, `SalesPeekScaffold`, `DocumentPeekShell`,
`SalesRecordBody`, `LineItemsGrid`, `panels.tsx` (totals / activity /
attachments), `useSalesDocumentRecord`, `useRecordPrint`.

That extraction was never finished. The drift is concrete, not cosmetic:

1. **Three record pages bypass the scaffold.** `InvoiceRecordPage` (349 lines),
   `EstimateRecordPage` (340), `SalesOrderRecordPage` (326) hand-roll
   `RecordShell` + `RecordHeader` + fetch + `<dl>` details grid + totals +
   activity. The other seven (Credit Note, Delivery Note, Proforma, Return,
   Recurring, Customer Payment, Customer) use `SalesRecordScaffold` and are
   120–160 lines. The three biggest, most-used documents are the outliers.

2. **`SalesPeekScaffold` has zero consumers.** Every peek sheet imports
   `DocumentPeekShell` directly and rebuilds its own body. The component whose
   entire purpose is "peek and full page cannot drift" is dead code, so they
   have drifted — `InvoicePeekSheet` is 278 lines with its own status map,
   its own totals block and its own line rendering, none shared with
   `InvoiceRecordPage`.

3. **Status vocabulary is duplicated per file.** Local `STATUS_TONE` /
   `STATUS_LABEL` maps live in at least six sales record files, plus their
   peek twins and the list pages. No single document-status registry exists,
   so the same invoice reads "Partial" in one surface and something else in
   another.

4. **Horizontal scroll is structural, not styling.** `LineItemsGrid` wraps
   its CSS-grid in `overflow-x-auto` around a hard `min-w-[720px]`. A peek
   drawer is narrower than 720px, so *every* peek scrolls sideways by
   construction, regardless of column count. `hideOnMobile` is keyed to the
   `sm:` viewport breakpoint, which is the wrong signal — the constraint is
   the container width, not the screen.

5. **Lifecycle navigation exists but is barely wired.**
   `DocumentLineageStrip` (Estimate → Proforma → SO → Delivery → Invoice,
   backed by the `get_document_lineage` RPC) is imported by nothing outside
   its own file. Downstream lifecycle (Payment → Journal Entry →
   Reconciliation → Credit Note → Return → Collections) is not modelled in it.

6. **Activity is a stub, not an audit trail.** `DocumentActivityPanel` is a
   good primitive, but callers feed it two synthetic entries built from
   `created_at` / `confirmed_by`. Real history exists in the database
   (`accounting_events`, `audit_logs`, approval and reversal event tables) and
   is not surfaced on any sales record.

7. **Data access is ad-hoc.** `InvoiceRecordPage` calls `supabase.from(...)`
   inside a `useEffect` with a cancellation flag, bypassing TanStack Query
   (no cache, no refetch, no shared state with the list). The scaffolded pages
   use `useSalesDocumentRecord`.

No duplicate invoice *renderer* was found: printing goes through the single
`useRecordPrint` → document-artifact pipeline. That boundary is healthy and
stays untouched.

## What this plan does

Finish the consolidation instead of starting a new one. One declaration per
document type, rendered by one engine, projected into two presentations
(drawer = triage, page = workspace).

### Phase 1 — Canonical document contract
Introduce a single `DocumentRecordView` descriptor: identity (type, number,
party, status), money (subtotal/discount/tax/total/paid/balance/currency),
dates, detail fields, line items, lifecycle links, activity. Each document
type contributes one adapter that maps its row to this shape. Drawer and page
both consume the descriptor; neither reads document tables directly.

### Phase 2 — Status registry
One `documentStatus` registry mapping every sales document status to a label
and a tone, consumed by lists, drawers, pages and badges. Delete the per-file
maps. An architecture test bans reintroducing a local status map in
`src/features/sales`.

### Phase 3 — Line items that never scroll unnecessarily
Rewrite `LineItemsGrid` around container queries rather than a fixed
`min-w-[720px]`:
- priority-ranked columns (description and amount always visible; qty and
  unit price next; discount, tax, UoM demoted first),
- demoted values collapse into a secondary line under the description in the
  drawer, and into an expandable row on narrow containers,
- sticky totals row, tabular-nums alignment, intelligent truncation with
  title tooltips.
Horizontal scroll becomes a last resort for genuinely wide grids, not the
default for the drawer.

### Phase 4 — Migrate the three outliers
Rebuild `InvoiceRecordPage`, `EstimateRecordPage`, `SalesOrderRecordPage` on
the scaffold + descriptor. Rebuild every peek sheet on `SalesPeekScaffold`.
Delete the hand-rolled shells, local status maps, and duplicated totals and
line blocks. Move invoice data access onto TanStack Query alongside the other
records.

### Phase 5 — Lifecycle and audit
Extend `DocumentLineageStrip` to the full chain (adding Payment, Credit Note,
Return, Collections, and a link through to the journal entry where one
exists), and mount it on every sales record page and drawer. Replace the
synthetic activity entries with a real timeline sourced from the existing
event and audit tables, grouped by day and collapsible.

### Phase 6 — Promote to platform primitives
Move the finished record layer from `src/features/sales/record` to a
document-workspace module under the design system, so Purchases (which already
imports `DocumentPeekShell`), Finance, Inventory and Warehouse inherit the
same header, totals, timeline, line grid, action bar and lineage strip.
Purchases peeks get repointed as the proof that the abstraction holds.

### Phase 7 — Verification and ratchets
- Architecture tests: no `RecordShell` usage outside the scaffold in sales,
  no local status maps, no direct `supabase.from` in a sales record page.
- Playwright pass over each document type at drawer width and page width,
  screenshotting line items to confirm no unintended horizontal scroll.
- Delete every component the migration orphans; no parallel renderers left.

## Visual design pass (folded into phases 3–4)
Density, type scale and spacing are currently set per file. The consolidated
scaffold fixes one rhythm: a single header hierarchy (party name as title,
document number as identity chip, status badge, money summary in the header
meta), one card elevation, tabular numerics everywhere money appears, and one
label typography for field grids. This lands as a consequence of the
consolidation rather than as a separate restyle.

## Scope note
No changes to posting, settlement, or document-artifact printing. This is
presentation and read-path architecture only; the ADR-0123 posting monopoly
and the print pipeline are left alone.
