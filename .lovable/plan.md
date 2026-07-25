## Confirmed: same engine, different inputs

Both statements go through the **same** renderer — `generateStatementPdf` in `supabase/functions/_shared/pdfGenerator.ts` (via `generate-document`). Nothing in the payroll path forks templates. What differs is the **fetcher input** and one **table-rule** styling issue.

Evidence (from parsing both PDFs):
- Customer statement (Fredrick Mureti): header shows "Joshua Holdings / KE", amounts formatted as `KES 0.00`, aging buckets rendered.
- Recipient statement (Nairobi Civil Court): no company name / country in header, amounts formatted as `$8,000.00`, and a horizontal double-rule sits over the Closing-Balance amount reading visually as a strike-through.

## Root causes

### 1. Wrong currency (USD instead of workspace KES)
`fetchLegalRecipientStatement` (index.ts:1558-1561) resolves currency as:
```
business?.base_currency  ||  recipient.organization?.base_currency  ||  "USD"
```
The `LegalRecipients.tsx` page never passes `businessId` in the request body, so `business` is `null`. The org row's `base_currency` is either unset or already USD for this workspace, so it falls through to the hard-coded `"USD"`. `customer_statement` doesn't hit this because the persisted `customer_statements` row carries `business_id` and the fetcher reads `stmt.business.base_currency` directly.

### 2. Missing letterhead branding
Same root cause: with `businessId` missing, `mapBusinessToOrg(supabase, null, org, null)` produces a header without the business name / country / branding block that the customer statement shows.

### 3. Rule strikes through the closing-balance amount
`DataTable` (`supabase/functions/_shared/pdf/components/DataTable.ts:462-472`) draws the grand-total double-rule at `y+2` / `y+4` — i.e. **inside the row's own top edge** rather than clearly above it. On tight row heights that pair of 1pt lines visually cuts across the "$8,000.00" figure. The customer statement rarely shows it because its grand-total row typically has more vertical breathing room from the aging summary above.

## Changes

**A. `src/pages/hr/payroll/LegalRecipients.tsx`**
- Pull `currentBusinessId` from `useBusinesses()` (already used elsewhere in payroll).
- Pass `{ periodStart: from, periodEnd: to, businessId: currentBusinessId }` to both `downloadPdf(...)` and `printDocument(...)` invocations (lines 242-266).

**B. `supabase/functions/generate-document/index.ts` — `fetchLegalRecipientStatement`**
- When `opts.businessId` is not supplied, attempt a graceful fallback: pick the caller's **single** active business for that org (e.g. via a `businesses` lookup filtered by `organization_id = recipient.organization_id` limit 2 — only use it if exactly one row exists) so admins who invoke the RPC without a body still get correct branding + currency.
- Keep the explicit `opts.businessId` path as the primary source.

**C. `supabase/functions/_shared/pdf/components/DataTable.ts` — grand-total rule**
- Move the grand-total double-rule from `y+2` / `y+4` to sit clearly **above** the row (e.g. `y + rowHeight - 1` and `y + rowHeight - 3`, matching the "top double rule / bottom of preceding row" accounting convention) so it never overlaps the amount glyphs on tight rows.
- This is a shared component; it also cleans up the customer statement's grand-total rendering when it appears without an aging block below it.

**D. Regression test**
- Extend `supabase/functions/generate-document/legal-recipient-statement-registered_test.ts` (or add a sibling `*_currency_test.ts`) asserting that when `businessId` is provided the fetcher's returned `currency` equals the business's `base_currency` and that `organization.name` is populated from the business branding.

## Non-goals

- No change to the `legal_recipient_statement` SQL RPC or the transaction shape.
- No change to the customer-statement fetcher.
- Not touching the duplicate "Payroll accrual" rows visible in the sample — those reflect the actual data returned by the RPC and are outside the print-engine question.
- No change to `useDocumentPrint` (recent auth fix stays as-is).

## Verification

1. Regenerate the recipient statement for Nairobi Civil Court with the same period → header shows the business name/country, amounts render as `KES …`, grand-total rule sits above the Closing Balance value, not across it.
2. Regenerate Fredrick Mureti's customer statement → still `KES`, still branded; grand-total rule now sits above the row cleanly.
3. New unit test passes; existing `legal-recipient-statement-registered_test.ts` still passes.
