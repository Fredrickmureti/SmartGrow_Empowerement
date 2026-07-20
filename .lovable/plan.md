## What the attached PDF actually is

The uploaded `receipt-POS1-260720-0006.pdf` was **not** produced by the thermal engine we shipped in Waves 6a/10. It was produced by the legacy A4 pipeline (`_shared/pdfGenerator.ts` → `PdfBuilder`). Three independent proofs from the file itself:

1. **Page size = 226.772 × 841.89 pt** — 80 mm wide × full A4 height. `renderThermalPdf` measures content height and produces a continuous-roll page (~150–250 pt for a two-item sale). Only `PdfBuilder` emits 841.89 pt.
2. **Contains the literal string `Report generated: 2026-07-20 01:07:10 UTC`.** That stamp is emitted only from `_shared/pdf/PdfBuilder.ts:194`. The thermal engine has no such block.
3. The header meta table (`Document #`, `Issue Date`, `Status`, empty `Customer:` label) is `BrandedHeader` two-column output, not the engine's flat left-padded rows.

So a POS `pos_receipt` request is *still* landing in `generateDocumentPdf`, even after Waves 6a (POS→thermal routing) and 10 (paper-aware routing) and Wave 11 (fast-fail guard) were "landed" in the plan log. The receipt looks bad because it is being rendered by the wrong engine, not because the thermal engine is bad.

## Why the guard didn't catch it

The current routing gate at `generate-document/index.ts:2692` is:

```text
routeThroughThermalEngine =
  !isStatement && (isThermalWidth || documentType === "pos_receipt")
```

and the Wave 11 assertion inside `generateDocumentPdf` only trips when `options.paperFormat` is `"40mm|58mm|80mm"`. Both rely on two things that break for a real tenant:

- `effectivePaper` is derived from `coerced.paper_format`, which comes from `document_print_policies`. A tenant with **no policy row** resolves to `"a4"`, so `isThermalWidth = false` and `renderOptions.paperFormat = "a4"`. The Wave 11 guard sees `"a4"` and stays silent.
- The `documentType === "pos_receipt"` short-circuit *should* still route through the engine — but it clearly didn't for this artifact. Two credible causes, both structural:
  - **Second entry point:** `send-document-email/index.ts:858` calls `generateDocumentPdf(docData, template)` directly with no policy resolution and no thermal routing. "Save PDF / Email PDF" flows that hit that function bypass every guard.
  - **Deployed edge functions can lag repo state.** The invariant "no thermal PDF may leave the A4 renderer" is enforced by *callers*, not by the renderer itself. That is not enterprise-grade — one forgotten call site (or one stale deploy) breaks it.

The root cause is architectural: the truth "this document is thermal" lives in `documentData.pos_receipt_settings.paper_size` and in the document type, but the guard reads only `options.paperFormat`. The guard is asking the wrong witness.

## The fix — six steps

### 1. Make `generateDocumentPdf` self-defending
Widen the Wave 11 guard so it inspects the document itself, not just the option bag. Fail hard on any of:
- `data.document_type ∈ {"pos_receipt", "receipt"}`
- `data.pos_receipt_settings?.paper_size ∈ {"40mm","58mm","80mm"}`
- `options.paperFormat ∈ {"40mm","58mm","80mm"}`

Error message names `renderThermalPdf` and the router helper (step 2). This turns the invariant into something the compiler-of-last-resort enforces regardless of caller discipline.

### 2. Extract one shared "policy-aware PDF" helper
Lift the routing block at `generate-document/index.ts:2655-2737` into `_shared/receipt/pdf/renderPolicyAwarePdf.ts`. Both `generate-document` and `send-document-email` call the helper; neither imports `generateDocumentPdf` directly. `no-restricted-imports` (or a small eslint/deno-lint rule) forbids other files from importing `generateDocumentPdf` — only the helper may.

### 3. Repair `effectivePaper` for POS receipts
Before the routing gate, override:
```text
effectivePaper =
  documentType === "pos_receipt"
    ? (pos_receipt_settings.paper_size ?? coerced.paper_format)
    : coerced.paper_format
```
This makes `isThermalWidth` true for every POS receipt, so `renderOptions.paperFormat` carries the truth, response headers (`X-Print-Policy-Effective-Paper`, `X-Print-Policy-Renderer`) become accurate, and the (still valuable) `paperFormat`-based guard is now redundant instead of load-bearing.

### 4. Runtime probe test (the missing backstop)
Add `supabase/functions/tests/thermal-routing.probe.test.ts` that fires a real `pos_receipt` request through `generate-document` and asserts:
- response header `X-Print-Policy-Renderer === "thermal-engine"`
- returned PDF page height ≤ 500 pt (i.e. NOT A4)
- returned PDF byte stream does NOT contain `"Report generated:"`

Run in CI. This is the guarantee that no future refactor can silently regress the router.

### 5. Force-redeploy both edge functions
After the code lands, deploy `generate-document` and `send-document-email` and re-hit the "Save PDF" flow from the terminal shown in the current preview. Verify page height, headers, and content against the probe.

### 6. Content cleanups the artifact also exposes (thermal engine, not A4)
Once the receipt is actually rendered by the engine, four cosmetic bugs remain visible in `lines.ts`:

- `Customer:` label is emitted with an empty value when no customer is attached — guard on `t.customer_name && t.customer_name.trim()`.
- `Status: COMPLETED` on a fully-paid cash sale is customer-facing noise — default `show_status` to `false` for `pos_receipt` in `defaultBusinessDocSettings`; keep it on for invoices / PO / SO.
- Payment lines render as `(KES 140.00)` (accounting parens = negative). Payments on a receipt are positive credits; only refunds should use parens. Fix the sign convention in the Paid/Tender emitter.
- The receipt is missing store address, cashier, register, payment method, and thank-you footer that the on-screen preview shows. This is a settings-source bug: the `pos_receipt_settings` snapshot the fetcher hands the engine must be the same one the preview reads (Phase 3 snapshot source). Log `X-Receipt-Settings-Source` on the probe response to confirm.

### Technical notes / affected files

- `supabase/functions/_shared/pdfGenerator.ts` — widen Wave 11 guard.
- `supabase/functions/_shared/receipt/pdf/renderPolicyAwarePdf.ts` — new, holds the extracted router.
- `supabase/functions/generate-document/index.ts` — call the helper; `effectivePaper` fix at ~2652.
- `supabase/functions/send-document-email/index.ts` — replace direct `generateDocumentPdf` call with the helper.
- `supabase/functions/_shared/receipt/lines.ts` — customer/status/payment-sign fixes.
- `supabase/functions/_shared/receipt/documentToInput.ts` — `defaultBusinessDocSettings` POS defaults.
- `supabase/functions/tests/thermal-routing.probe.test.ts` — new CI probe.
- `.lovable/plan.md` — record Waves 13 (self-defending renderer), 14 (single entry point), 15 (probe), and closing content items.

### Out of scope for this plan
Sales-app invoice PDF cleanup (Wave 6b.2 remaining shim-gap items). That work continues after the router is provably watertight.

## Acceptance

- A fresh POS "Save PDF" produces a PDF whose page height is measured (< ~500 pt for a small sale), with no `Report generated:` string, no A4 meta table, no bare `Customer:` label, no `(KES …)` on paid lines, and the same store/cashier/footer as the on-screen preview.
- Response headers show `X-Print-Policy-Renderer: thermal-engine` and `X-Print-Policy-Effective-Paper: 80mm`.
- CI probe passes. Removing the router or reintroducing the bypass makes CI red.
