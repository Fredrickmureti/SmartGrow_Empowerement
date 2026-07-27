## Diagnosis

The CORS preflight failure is a symptom, not the actual problem. The real cause is that the canonical print pipeline edge functions were **never deployed** to Supabase.

Direct probe of the edge runtime confirms this:

```text
OPTIONS /functions/v1/submit-document-intent  → 404 NOT_FOUND
OPTIONS /functions/v1/dispatch-print-jobs     → 404 NOT_FOUND
OPTIONS /functions/v1/resolve-output-intent   → 404 NOT_FOUND
OPTIONS /functions/v1/generate-document       → 200 OK
```

When a function doesn't exist, Supabase's gateway returns 404 to the browser's preflight `OPTIONS`. The browser reports this as "Response to preflight request doesn't pass access control check: It does not have HTTP ok status." That's exactly what the user is seeing.

The function source at `supabase/functions/submit-document-intent/index.ts` is correct — CORS headers, OPTIONS handler, imports, and shared helper all look fine. It simply hasn't been pushed to the edge runtime. `generate-document` (which was touched more recently and works) confirms deploys do reach this project — these three canonical pipeline functions just never got shipped.

This also explains why labels "print" from inventory: the label path likely does not funnel through `submit-document-intent` today, or uses a different endpoint that is deployed.

## Plan

1. Force a redeploy of the three canonical print pipeline edge functions so the edge runtime registers them:
   - `submit-document-intent`
   - `dispatch-print-jobs`
   - `resolve-output-intent`

   Mechanism: a no-op touch (whitespace/comment) on each `index.ts` so the platform's auto-deploy picks them up. No behavioral changes.

2. After the touch, verify each function is reachable:
   - `OPTIONS` returns `200` with the expected `Access-Control-Allow-*` headers
   - A minimal `POST` with an invalid body returns a structured `400` (proving the handler is executing), not `404`

3. Retry Print Invoice from the UI and confirm the flow reaches `print_jobs` instead of failing at the browser's preflight.

4. If any of the three functions fails to deploy after the touch (still 404), read that function's deploy logs to identify the boot error and fix it — but do not preemptively change function code before confirming a deploy error, because the source currently looks correct.

## Out of scope

- No change to the canonical architecture, snapshot builders, hardware routing, or the already-fixed `businesses.base_currency` projection.
- No UI changes on `Invoices.tsx` — the previous error-surfacing improvement stays.
- No new functions, no config.toml edits (functions auto-deploy from `supabase/functions/<name>/index.ts`).