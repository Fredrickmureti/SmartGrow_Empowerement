# Journal Voucher: root cause and fail-closed rebuild

## What the evidence shows

I inspected the uploaded PDF and the live system rather than the previous agent's claims.

The uploaded artifact is invoice-shaped ("Bill To", Qty/Price/Tax, "Total KES 0.00", "Thank you for your business!"), yet its title is "JOURNAL VOUCHER" — that title comes from `document_type_label` inside the journal snapshot. So the correct snapshot reached a commercial renderer.

Live database facts (queried, not assumed):
- `document_records` has one row for JE-00001, `kind_code = finance.journal_entry`, not superseded.
- Its frozen snapshot is fully correct: two ledger lines (7,000 Dr Operating Expenses / 7,000 Cr Cash on Hand), totals, `is_balanced: true`, audit trail, source `expense`, reference EXP-00001. It has no `items` array — which is exactly why the invoice table printed empty and the total printed 0.00.
- The system template for `finance.journal_entry` exists with `layout: journal_voucher` and ledger blocks (`ledger_lines`, `debit_credit_balance`, `audit_trail`) — no party block, no line-item preset.
- `document_artifacts` has zero rows for this record (and none in the last two days), so the bytes were never archived.
- `render-document` booted twice at 00:55:54 / 00:55:56, immediately before the PDF timestamp of 00:55:57. `generate-document` has no logs at all.

## Root cause (high confidence, one step left to confirm)

The current repository source *cannot* produce the uploaded PDF for this record. In `supabase/functions/_shared/rendering/renderers/pdf.ts` the `finance.journal_entry` key is registered in `LEDGER_LAYOUTS` ahead of every other branch, and `assertJournalTemplateContract` runs before it. Against the live template, that path would either draw the journal voucher or throw a configuration error — it could not reach `generateDocumentPdf`.

So the deployed `render-document` bundle was running an older copy of the shared renderer, from before the journal registration, and fell through to the generic commercial renderer. That is a deployment-freshness defect that exposes a real architectural defect: the fallthrough to `generateDocumentPdf` is silent and unconditional, so any kind without a registered layout renders as an invoice instead of failing.

Step one is to confirm this by redeploying and re-rendering the same record. If the redeployed function still produces invoice output, the diagnosis is wrong and the trace continues before any layout work begins.

## Plan

1. **Confirm the runtime cause.** Redeploy `render-document` and every function importing the shared PDF/rendering modules, then re-render document record `ce44e716-…` and read the resulting bytes. Capture pre/post output as evidence.

2. **Remove the silent semantic fallback.** `generateDocumentPdf` becomes reachable only for kinds whose template declares commercial anatomy. When a template AST declares a non-commercial `layout` (e.g. `journal_voucher`) or carries no line-item/party blocks, and no dedicated renderer is registered for its kind, the renderer raises a diagnosable `renderer_not_registered:<kind>` error instead of drawing an invoice.

3. **Fix artifact persistence.** Zero persisted artifacts means `persistArtifact` is failing and being swallowed by a `console.warn`. Diagnose the failure and make it visible (logged with cause, surfaced in render metadata) so "the artifact IS the record" actually holds.

4. **Verify the voucher layout against the real snapshot.** Render `generateJournalVoucherPdf` from the frozen JE-00001 snapshot and inspect every page: company identity, JOURNAL VOUCHER title, meta grid (number, posting date, period, journal, status, reference, source, currency, exchange rate where applicable), narration, ledger table (Account code / Account / Description / Debit / Credit, right-aligned amounts), Total Debits = Total Credits control, audit trail, reversal linkage, page numbers, repeated table headers. Fix layout defects; no invoice vocabulary anywhere.

5. **Exercise the variants.** Manual journal, system-generated journal (this one, sourced from an expense), draft journal, reversal journal if present in the data, and a synthetic many-line journal to prove multi-page behaviour with repeated headers and long narrations.

6. **End-to-end lifecycle check.** Preview, Print and Download from the detail page, peek sheet and list row all resolve to the same record, same snapshot, same voucher renderer, and produce identical accounting facts on repeat.

7. **Regression ratchets.** Tests asserting: journal entry resolves to `finance.journal_entry`, to its own snapshot builder and its own renderer; a journal entry can never reach the invoice/bill/generic commercial renderer; a kind with a declared non-commercial layout and no renderer fails loudly; the rendered voucher contains debit/credit lines and balanced totals.

8. **Remove dead code.** Anything the trace proves obsolete (unreferenced journal print paths, duplicate registrations) gets deleted, not annotated as legacy.

## Final report

Root cause, architectural finding, files/migrations changed, code removed, tests run with results, the regenerated PDF inspected page by page, and an explicit PASS / NOT PASS verdict.