# Credit Note 404 — End-to-End Resolution Plan

## Verified current state

- The live database has exactly one creation RPC: `public.create_credit_note_atomic(_payload jsonb)`.
- It is executable by `anon`, `authenticated`, and `service_role`.
- The current frontend source calls that RPC with the named `_payload` envelope.
- Supabase gateway logs confirm the browser is still receiving repeated HTTP 404 responses on that exact route.
- Invoice `INV-00001` exists, is paid, totals KES 9,000, and belongs to contact `54709d33-f976-4c42-8f2e-f27cca6a85fd`.
- The available logs do not expose the POST body or 404 response body, so the precise mismatch is not yet proven.

## Resolution sequence

1. **Capture the exact failing exchange**
   - Reproduce submission from the authenticated preview.
   - Intercept and record the RPC request’s JSON key names and the complete PostgREST error payload (`code`, `message`, `details`, `hint`).
   - Confirm which loaded JavaScript module initiated the request, rather than inferring it from repository source.

2. **Fix the proven divergence only**
   - If the loaded client sends the wrong body, converge the actual runtime call path on `{ _payload: ... }` and remove any obsolete registration/cache mechanism keeping old code active.
   - If the loaded client sends the correct body but PostgREST rejects it, compare the captured error against the live function metadata and repair the catalog/signature/grant issue with one migration.
   - Do not add adapters, overloads, duplicate RPCs, or fallback writers.

3. **Perform the requested authenticated transaction**
   - Create a KES 9,000 credit note for Fredrick Mureti against `INV-00001` through the same UI/runtime path the operator uses.
   - Use one valid KES 9,000 line and create it as a draft first, avoiding an unintended accounting post while proving creation.

4. **Verify database and browser outcomes**
   - Require HTTP success and a returned `credit_note_id`/number.
   - Query the created header and line to prove customer, invoice, currency, and KES 9,000 total.
   - Confirm exactly one credit note was created and no partial or duplicate record remains from the test.
   - Reload the page and confirm the created credit note is visible without another 404.

5. **Lock the regression down**
   - Add a focused contract test for the exact serialized RPC body, not merely a source-text assertion.
   - Keep the architectural rule: one canonical `_payload jsonb` writer and no client-side accounting logic.

## Completion criterion

This is complete only when the authenticated browser flow creates and reloads the KES 9,000 credit note for Fredrick Mureti against `INV-00001`. A 401 probe, schema lookup, cache reload, or unit test alone does not count.