## What I confirmed

- The payroll route mounts `LegalRecipients` under `/hr/payroll/legal-orders/recipients`.
- The page uses `useDocumentPrint()` and sends this body when the user clicks **Download PDF** or **Print**:

```ts
{
  documentType: "legal_recipient_statement",
  documentId: selected.recipient_id,
  format: "pdf",
  periodStart: from,
  periodEnd: to
}
```

- Current source for `generate-document` already contains a special-case fetcher for `legal_recipient_statement` that requires `periodStart` and `periodEnd`, reads `legal_recipients`, calls the SQL RPC `legal_recipient_statement`, and renders through the shared statement PDF renderer.
- The live database has both relevant RPCs:
  - `public.legal_recipient_statement(p_recipient_id uuid, p_from date, p_to date)`
  - `public.legal_order_recipient_statement(_organization_id uuid, _recipient_id uuid, _from date, _to date)`
- The live database currently has at least one recipient row in `legal_recipient_outstanding`, so the page has a real recipient id to pass.

## Most likely root cause to verify before fixing

The reported HTTP status is **400 Bad Request**, not 500. In the current `generate-document` source, the relevant 400 path for this request is the **unsupported document type** guard. That means the deployed `generate-document` function that handled your click may not include the newer `legal_recipient_statement` registration, even though the repo source now does.

I will not treat that as final until I reproduce the function response with an authenticated request or inspect the exact deployed function logs/body.

## Implementation plan

1. **Reproduce the failing request with the exact payload**
   - Use the known recipient id from the live data.
   - Invoke `generate-document` with `documentType: "legal_recipient_statement"`, `format: "pdf"`, and the same period fields.
   - Capture the actual JSON response body, not just the browser stack trace.

2. **Confirm the deployed backend version**
   - Check whether the deployed function response says `Unsupported document type: legal_recipient_statement`.
   - If logs are sparse, add/inspect narrow logging around document-type dispatch only if needed.

3. **Fix the root cause depending on confirmed response**
   - If deployed code is stale: deploy the current `generate-document` function so the existing `legal_recipient_statement` fetcher is live.
   - If the deployed code is current but the response is a different 400: fix the exact failing contract path only, based on the response body/logs.

4. **Add a regression guard**
   - Add an edge-function architecture/unit test proving `legal_recipient_statement` is registered in `FETCHER_MAP`, included in `TEMPLATE_TYPE_MAP`, included in statement rendering, and dispatched through `fetchLegalRecipientStatement` with `periodStart`/`periodEnd`.
   - This prevents the payroll recipient statement from silently falling out of the document engine again.

5. **Verify end-to-end**
   - Re-run the exact edge-function request.
   - Confirm it returns `application/pdf` and starts with `%PDF`.
   - Then verify the page buttons no longer hit the 400 path.

## Files likely involved

- `src/pages/hr/payroll/LegalRecipients.tsx`
- `src/hooks/useDocumentPrint.ts`
- `supabase/functions/generate-document/index.ts`
- `supabase/functions/generate-document/*_test.ts`