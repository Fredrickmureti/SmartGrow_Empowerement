## Diagnosis confirmed

The failing request is not hardware binding or label routing. It is a schema mismatch in the sales document snapshot path:

```text
GET /rest/v1/businesses?select=id,name,legal_name,email,phone,address,logo_url,currency...
```

The `public.businesses` table does not have a `currency` column. It has `base_currency`. I verified this directly against the database. The same business row exists and is active, so this is not missing company data.

Labels still print because the inventory label pipeline does not use this stale `businesses.currency` projection.

## Implementation plan

1. Replace stale `businesses.currency` selects with `businesses.base_currency` in the document snapshot builders:
   - Sales invoice
   - Sales estimate
   - Sales credit note
   - Sales order
   - Sales proforma
   - Sales return
   - Purchase order
   - Vendor bill

2. Update the corresponding TypeScript business row shapes from `currency` to `base_currency` so future edits don't reintroduce the wrong column.

3. Keep the canonical print architecture unchanged:
   - `fetchAndBuild...Snapshot`
   - `ensureDocumentRecord`
   - `submitDocumentIntent`
   - `print_jobs` / routing / hardware path

4. Improve the invoice print failure surface only where needed by preserving the actual PostgREST error message in the toast instead of masking it as a generic unexpected print failure.

5. Verify with a targeted search that no remaining document snapshot builder queries `businesses.currency`.