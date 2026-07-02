# Settings — Consumers Audit

For every branch-overridable setting (whitelisted in `branch_overridable_settings`), this doc lists **every runtime consumer**. The contract: any consumer of a branch-overridable key MUST read it through `useDocumentBranding()` (or `getEffectiveCompanyConfig` for non-document contexts), passing the record's `business_id` AND `branch_id`.

Direct reads from `businesses.*` (without going through the resolver) are acceptable ONLY for keys that are **not** branch-overridable (tax_id, base_currency, fiscal_year_start, etc).

## Whitelisted keys → consumers

| Setting key | Consumers | Resolver path |
|---|---|---|
| `document_logo_url` | Invoice PDF render, Bill PDF render, Estimate PDF render, POS receipt, Email header, Customer portal header | `useDocumentBranding(invoice.business_id, invoice.branch_id).branding.logo_url` |
| `document_address` | All printed documents (invoice, bill, estimate, receipt) header block | `useDocumentBranding(...).branding` (assembled from address/city/country) |
| `invoice_prefix` | `useInvoiceNumber()` sequence generator, invoice PDF, sales reports filter chip | resolver returns `invoice_prefix.value` already concatenated with branch suffix |
| `estimate_prefix` | `useEstimateNumber()`, estimate PDF | resolver returns `estimate_prefix.value` |
| `bill_prefix` | `useBillNumber()`, bill PDF | resolver returns `bill_prefix.value` |
| `receipt_prefix` | POS receipt printer, POS daily Z-report | resolver returns `receipt_prefix.value` |
| `contact_email` | Email "from" header on invoices, statements, payment receipts; customer portal contact link | resolver returns `contact_email.value` |
| `contact_phone` | Receipt footer, customer portal contact, SMS notifications | resolver returns `contact_phone.value` |

## Non-overridable settings — direct reads are fine

These keys are read directly from `businesses` (or `organizations` for platform-wide) because they MUST be uniform across all branches of a company:

| Setting | Reader pattern |
|---|---|
| `base_currency` | `businesses.base_currency` (also exposed via `useDocumentBranding().branding.base_currency`) |
| `tax_id` | `businesses.tax_id` |
| `fiscal_year_start` | `businesses.fiscal_year_start` |
| `timezone` | `businesses.timezone` |
| `chart_of_accounts` | `chart_of_accounts` table (org-scoped) |
| Tax rates | `tax_rates` table (org-scoped) |

## How to verify

- `useDocumentBranding` is the canonical hook. `getEffectiveCompanyConfig` is the underlying resolver.
- Architecture guard `src/test/architecture/no-org-identity-reads.test.ts` fails CI if any document/accounting surface reads identity from `currentOrg` directly.
- Architecture guard `src/test/architecture/no-org-logo-url.test.ts` fails CI if any code references the dropped `organizations.logo_url`.
- The BranchConfiguration UI (`src/components/settings/BranchConfiguration.tsx`) shows live `Effective` values — set an override and visually confirm it propagates to the next invoice/receipt.

## Adding a new consumer

When wiring a new document-rendering surface (PDF, email, receipt, statement):

1. Get the record's `business_id` AND `branch_id` (from the row, not from the user's selection).
2. Call `useDocumentBranding(record.business_id, record.branch_id)`.
3. Read `branding.logo_url`, `branding.invoice_prefix`, etc. — never read these from `currentOrg` or `currentBusiness` directly.
4. The `_source` map (when present) tells you provenance: render a "Branch override" chip in admin views if the consumer is an internal preview.
