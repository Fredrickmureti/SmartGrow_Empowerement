## Verified current state

- The live symptom is architectural, not cosmetic: cluttered 40/58/80mm PDFs are A4-style coordinate PDFs being squeezed onto thermal widths or otherwise bypassing the receipt engine.
- `generate-document` now contains a thermal PDF branch that routes thermal-width documents and `pos_receipt` into `_shared/receipt/lines.ts` + `renderThermalPdf`.
- `generateDocumentPdf` now has a self-defending guard that refuses `pos_receipt`, `receipt`, or `pos_receipt_settings.paper_size` in `40mm|58mm|80mm`.
- A remaining confirmed bypass exists in `send-document-email`: standard ERP item-table documents still construct `DocumentData` locally and call `generateDocumentPdf` directly, while only `customer_statement`, `receipt`, and `pos_receipt` use `generate-document`.
- This explains why Sales/Purchases thermal-profile documents can still behave badly even after POS routing work: not every PDF artifact is owned by the canonical router.

## Canonical architecture to implement

```text
UI Save PDF / Print PDF / Email PDF
        |
        v
generate-document edge function
        |
        +-- thermal paper or POS receipt --> shared receipt engine --> renderThermalPdf
        |
        +-- A4/Letter/A5 business doc ----> generateDocumentPdf
        |
        +-- statements -------------------> generateStatementPdf
```

No other edge function should directly call `generateDocumentPdf` for ERP documents.

## Implementation plan

1. **Remove email renderer bypass**
   - Update `send-document-email/index.ts` so every non-payslip ERP attachment calls `generate-document` with `format: "pdf"`.
   - Preserve payslips on their dedicated `generate-payslip-pdf` function.
   - Remove local item/template/custom-field reconstruction for email attachments, because that duplicates the document renderer and bypasses print policy.

2. **Preserve print-policy intent for email PDFs**
   - Keep `resolvePrintPolicy` in `send-document-email` only to pass the configured paper format into `generate-document` while forcing `renderMode: "pdf"`.
   - Use the document branch when available, so branch-level thermal policies are respected for Sales/Purchases documents.

3. **Add a runtime/probe backstop**
   - Add focused edge-function tests/probes for `generate-document` verifying:
     - POS `format: "pdf"` returns `X-Print-Policy-Renderer: thermal-engine`.
     - Thermal Sales/Purchases PDFs route through the thermal engine when policy paper is `40mm`, `58mm`, or `80mm`.
     - Thermal PDFs do not contain legacy A4-only markers such as `Report generated:`.
     - Page height/width are thermal-roll shaped, not A4 height.

4. **Add architecture guard against future bypasses**
   - Add a small test or static check that `generateDocumentPdf(` is only called from the canonical owner (`generate-document`) and allowed dedicated non-ERP generators/tests.
   - This prevents future email/export modules from reintroducing the same duplicate renderer.

5. **Deploy and verify live edge functions**
   - Deploy `generate-document` and `send-document-email` after code changes.
   - Check deployed function logs for the `[thermal-route]` marker and absence of `generateDocumentPdf refused` for normal thermal PDF saves.
   - Generate a fresh POS PDF and inspect the actual returned artifact: headers, PDF dimensions, and absence of A4 pipeline markers.

6. **Only after routing is proven, finish content-level receipt cleanup**
   - Fix remaining receipt-line details in `_shared/receipt/lines.ts` only once the artifact is proven to be from `renderThermalPdf`:
     - suppress empty `Customer:` rows,
     - ensure payment lines render as positive tenders unless the transaction is a refund,
     - keep tax buckets and wrapped line widths stable across 40/58/80mm.

## Acceptance criteria

- POS Save PDF produces a thermal-engine PDF, not the A4 pipeline.
- Sales/Purchases documents with 40/58/80mm print profiles produce thermal-engine PDFs, not squeezed A4-style PDFs.
- Email attachments use the same PDF router as Save PDF.
- A future direct `generateDocumentPdf` bypass fails tests before it reaches production.