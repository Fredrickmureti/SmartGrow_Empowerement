## Diagnosis so far

`POST /functions/v1/generate-tax-certificate → 422` is *not* a crash — the edge function returns a structured `businessError` envelope on purpose. Inside `generate-tax-certificate/index.ts` there are exactly four 422 code paths:

| # | Where | `code` returned | Typical cause |
|---|---|---|---|
| 1 | L363 | `TEMPLATE_STRUCTURAL_INVALID` | Template is not v3 (schema_version < 3) |
| 2 | L400 | `TEMPLATE_STRUCTURAL_INVALID` | v3 doc has no matrix/grid/table node |
| 3 | L437-443 (`validateCanonicalSourceNode`) | `TEMPLATE_STRUCTURAL_INVALID` | Matrix/grid columns not bound to canonical rule codes |
| 4 | L508 | `LIFECYCLE_REFUSED` (from `requireApprovedRunsForYear`) | No approved/committed payroll runs for the fiscal year, or blocking readiness findings |

The client toast reads `"An unexpected error occurred. Please try again."` because the mutation error is being normalised by a generic handler in `TaxCertificates.tsx` (`normalizeError(e).message`) that isn't picking up the JSON envelope. `supabase.functions.invoke` wraps non-2xx into `FunctionsHttpError` whose body lives on `.context` (a Response) and is not read by default — the hook does try to parse it via `readFunctionErrorPayload`, but the real `code`/`message` need to be surfaced instead of the fallback string.

So there are **two bugs stacked on top of each other**:

1. **A real refusal** from the edge function (one of the four codes above) — we don't know which yet because the client swallows the payload.
2. **The toast masks it**, showing a generic message instead of the server-provided `message` + `recovery`.

## Plan

### Step 1 — Reveal the actual refusal code (no code changes)

Add a temporary `console.log(err.code, err.payload)` inside `useGenerateTaxCertificate`'s error branch, or ask the user to open DevTools → Network → click the failed `generate-tax-certificate` request → Response tab and paste the JSON. This is the fastest ground truth: it tells us whether we're dealing with `LIFECYCLE_REFUSED` (most common — the payroll runs for that FY aren't approved) vs a template structural issue.

Given the readiness block in `TaxCertificates.tsx` (`committedRuns === 0`, `blockingFindings`), `LIFECYCLE_REFUSED` is the leading hypothesis.

### Step 2 — Fix the toast masking (regardless of cause)

In `src/pages/hr/payroll/TaxCertificates.tsx` `runGenerate`, prefer the structured payload the hook already attaches:

```
const err = normalizeError(e);
const serverMsg = e?.payload?.message ?? e?.payload?.error ?? err.message;
const recovery = e?.payload?.recovery;
toast.error(serverMsg, recovery ? { description: recovery } : undefined);
```

Also tighten `readFunctionErrorPayload` in `useTaxCertificates.ts` if it fails to read `error.context` as a `Response` clone (mirror the `hydrateFunctionsError` helper already used by `invokeWithAuth.ts` — it correctly clones and parses the body). Switching this hook to `invokeWithAuth` is the cleanest fix and reuses the already-hardened error hydration.

### Step 3 — Fix the underlying refusal

Depending on the code from Step 1:

- **`LIFECYCLE_REFUSED`** — surface the readiness reasons in the "Generate" button's tooltip (they're already computed as `blockedReasons`) and *disable* the button when `blockedReasons.length > 0`. The current UI lets the user click generate even when readiness is red, producing this 422.
- **`TEMPLATE_STRUCTURAL_INVALID`** — the localization pack for KE P9 needs republishing (canonical KE P9 body already lives at `src/features/localization/lib/engine/templates/keP9.ts` per `mem/features/certificate-rendering.md`). The fix is to reinstall/upgrade the pack; the pack-upgrade banner in `TaxCertificates.tsx` should be made blocking.
- **`TEMPLATE_NOT_INSTALLED`** (404, not 422 — sanity check) — install the KE pack via Settings → Localization.

### Step 4 — Verify

- Reproduce via the UI after Step 2 lands and confirm the toast now shows the real message + recovery.
- If cause is lifecycle, approve a payroll run for the FY and re-generate — expect 200 with `created: [...]`.
- Add a regression test in `src/hooks/payroll/__tests__/useTaxCertificates.test.ts` (or extend the existing one) that a 422 `FunctionsHttpError` with a JSON body ends up as `err.code === "LIFECYCLE_REFUSED"` and `err.message === payload.message`.

## Files likely to change (Step 2/3 only)

- `src/hooks/payroll/useTaxCertificates.ts` — replace `supabase.functions.invoke` with `invokeWithAuth`, so the error payload is hydrated onto `err.code / err.message / err.body`.
- `src/pages/hr/payroll/TaxCertificates.tsx` — read `err.payload` / `err.recovery` in the toast, and gate the Generate buttons on `blockedReasons.length === 0`.

## What I need from you to proceed

Please paste the JSON body of the failing 422 response (DevTools → Network → `generate-tax-certificate` → Response). That single value pins Step 3 to exactly one branch and I can implement without guessing.