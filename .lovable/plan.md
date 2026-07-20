
# Enterprise Output Platform — resume at Phase 3 (D3)

## Verification of prior work (Phases 0–2)

Independently re-checked `.lovable/plan.md` claims against the codebase:

- **Phase 0 (ADR + audit ledger)** — `docs/adr/0086-enterprise-output-platform.md` and `docs/audit/2026-07-20-enterprise-output-platform.md` exist and codify the 5-stage pipeline plus the D1–D6 ledger.
- **Phase 1 (D1 · Label / ZPL)** — `supabase/functions/_shared/printing/zpl/builder.ts` present; guardrails green:
  - `label-builder-has-no-hardcoded-zpl.test.ts` (2/2)
  - `label-template-substitution-parity.test.ts` (4/4)
  - `zpl-golden.test.ts` (6/6)
- **Phase 2 (D2 · `pdf-lib` in edge)** — rule `eslint-rules/no-raw-pdf-lib-in-edge-functions.js` present, wired at `error` in `eslint.config.js`, allowlists only `_shared/pdf/**` and `_shared/receipt/pdf/**`, supports bare / `npm:` / `esm.sh` specifiers with `RENDERER-EXEMPT` escape hatch. Architecture test `adr-0086-edge-pdf-lib-ownership.test.ts` green (3/3). D5 correctly absorbed.
- **Phase 4 (D4)** and **Phase 5 (D5)** — confirmed no-op / absorbed.
- **Phase 6 (D6)** — legitimately deferred, low risk.

Conclusion: Phases 0–2 are complete and enterprise-grade. **Phase 3 (D3) is the correct resumption point** — no re-work needed upstream.

## Confirmed remaining drift (D3)

Two `src/pages/**` surfaces still call `supabase.functions.invoke("generate-document", …)` directly, bypassing the canonical client entrypoint `useDocumentPrint`:

- `src/pages/CustomerStatements.tsx:316` — single-statement PDF download.
- `src/pages/VendorStatements.tsx:281` — single-statement PDF download.

Both handlers download a PDF (not preview) after resolving a `statementId`, then `downloadPdfBlob(...)`. This is exactly what `useDocumentPrint.downloadPdf(documentType, id, filename)` already does — including the `%PDF` magic-byte defense and toast handling. The bulk-generation paths in these files invoke `send-document-email`, which is a different edge function and out of scope for D3.

No other `src/pages/**` file directly invokes `generate-document` (spot-checked; will re-verify in step 4 below).

## Implementation

### Step 1 — Migrate CustomerStatements

In `src/pages/CustomerStatements.tsx` (`handlePrint` around L312–L325):

- Remove the dynamic `supabase` + `downloadPdfBlob` imports and the direct `functions.invoke("generate-document", …)` block.
- Replace with `downloadPdf("customer_statement", statementId, filename)` from `useDocumentPrint` (import the hook at the top of the component and destructure `downloadPdf` alongside existing state).
- Compose the same `filename` (`Statement_<sanitized name>_<yyyy-MM-dd>`); hook appends `.pdf` and toasts on success/failure, so remove the local success toast and matching try/catch error toast for the PDF step (keep any state resets — `setIsGenerating(false)` moves into a `finally` around the `downloadPdf` call, or we rely on the hook's `isGeneratingPdf`; keep the page's `isGenerating` for the pre-download work only).

### Step 2 — Migrate VendorStatements

Same change in `src/pages/VendorStatements.tsx` (`handlePrint` around L281–L289): swap the direct invoke for `downloadPdf("vendor_statement", statementId, filename)` from `useDocumentPrint`. Preserve the surrounding `statementId` resolution and business-scope logic unchanged.

### Step 3 — Guardrail: forbid direct `generate-document` in pages

Add ESLint rule `eslint-rules/no-direct-generate-document-in-pages.js` (mirroring the style of `no-document-print-shadow-path.js`):

- Scope: `src/pages/**` and `src/features/**/pages/**`.
- Flag any `CallExpression` matching `supabase.functions.invoke("generate-document", …)` (also handle aliased `functions.invoke` and dynamic-imported `supabase`).
- Allowlist: none initially. The two hook files (`useDocumentPrint.ts`, `useDocumentPrintPolicies.ts`) are outside the scoped glob so they naturally pass.
- Message: `"Direct generate-document invocation in a page bypasses the canonical print entrypoint. Use useDocumentPrint (ADR-0086 / D3)."`
- Escape hatch: `// RENDERER-EXEMPT: <reason>` on the preceding line, matching ADR-0085 convention.

Register in `eslint.config.js` at `error` level for `src/pages/**/*.{ts,tsx}` and `src/features/**/pages/**/*.{ts,tsx}`.

### Step 4 — Architecture test locking D3

New `src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts`:

1. Reads the rule module from disk and asserts it's registered at `error` under `local/` for the scoped glob in `eslint.config.js`.
2. Ripgrep sweep over `src/pages/**` + `src/features/**/pages/**` for the literal string `generate-document` — expects zero non-exempt matches.
3. Positive test: temporary in-memory `RuleTester` case with `supabase.functions.invoke("generate-document", { body: {} })` → 1 report; add negative case for `useDocumentPrint` usage → 0 reports.

### Step 5 — Runtime verification

Playwright script under `/tmp/browser/d3-statements/`:

1. Auth via injected Supabase session.
2. Navigate to `/customer-statements`, resolve or generate a period, click **Print/Download**. Capture network: expect exactly one `POST /functions/v1/generate-document` with `documentType: "customer_statement"` and `format: "pdf"` (identical headers/body shape as pre-migration).
3. Assert the downloaded blob starts with `%PDF`.
4. Repeat for `/vendor-statements` with `documentType: "vendor_statement"`.
5. Screenshot success toast for both.

If the pages are gated by data that's not seedable in the sandbox, fall back to a lower-level runtime proof: mock `supabase.functions.invoke` in a component test that renders the page's print handler and asserts the hook's `downloadPdf` was called with the correct `(documentType, id, filename)`.

### Step 6 — Ledger + plan updates

- Mark **Phase 3 · D3** Done in `docs/audit/2026-07-20-enterprise-output-platform.md` with resolution notes (migrated files, new rule, runtime proof).
- Update `.lovable/plan.md`: Phase 3 row → Done; active phase → Phase 6 (D6) or "roadmap closed except deferred D6"; append handoff notes for D6 revisit (server-side ZPL literals — low priority per prior audit).

## Out of scope (intentional)

- **D6 (server-side ZPL)** — deferred as originally scoped; audit ledger already classes it low. Not part of this plan.
- The `send-document-email` calls in the bulk-generate handlers — different edge function, different ledger entry (none open), no drift.
- Any changes to `generate-document` itself, PDF renderer internals, or the receipt Line AST — those are already canonical.

## Technical notes

- `useDocumentPrint.downloadPdf` already sends `format: "pdf"` (matching current inline behavior), validates `%PDF` magic bytes, and toasts — so the migration is behavior-preserving.
- The `DocumentType` union in `useDocumentPrint.ts` already includes `"customer_statement"` and `"vendor_statement"`; no type surface changes.
- `no-document-print-shadow-path.js` bans *new* `useDocumentPrint` importers via allowlist; extend that allowlist to include `src/pages/CustomerStatements.tsx` and `src/pages/VendorStatements.tsx` in the same edit batch so the migration doesn't trip the existing rule.
