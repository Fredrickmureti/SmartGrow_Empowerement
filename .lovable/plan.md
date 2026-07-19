# Enterprise Document Platform — Printer-Profile Verification

## TL;DR (root cause)

The printer-profile subsystem **is** wired end-to-end — DB → resolver → `generate-document` → renderer — but a **deliberate server-side coercion** rewrites `(thermal paper) + (pdf render_mode)` to `A4 + PDF` for every non-POS document type. The admin UI in `Settings → Printing` still lets operators pick that exact combination. That mismatch is what you're observing: the config is saved, resolved, then overridden one call later. This is **not a rendering bug and not a lost value** — it is an **authority conflict between the admin UI and the coercion policy**.

## Evidence (traced flow for Sales Invoice = "Thermal 80mm + PDF")

1. **Admin UI writes the row.** `src/components/settings/PrintingSettings.tsx` L42–44 offers `80mm / 58mm / 40mm` for every document type in the registry, and L211–223 lets `render_mode` stay `pdf`. Upserts land in `document_print_policies` (migrations `20260511*`, `20260513*`, `20260617*`, `20260618*`).
2. **Client asks for the PDF.** `useDocumentPrint` / `PrintPreviewDialog` call `generate-document` with `format: "pdf"` (explicit) and no `paperFormat` override.
3. **Policy is resolved correctly.** `supabase/functions/_shared/printing/resolvePolicy.ts` returns `{ paper_format: "80mm", render_mode: "pdf", source: "business" }`. ✅ Value survives to the edge function.
4. **Coercion overrides it.** `supabase/functions/generate-document/index.ts` L2358–2387 → `coercePaperRenderMode` in `_shared/printing/coercePolicy.ts` L82–95:
   - Non-POS doc + thermal paper + explicit `format=pdf` → **rewritten to `a4 / pdf`** with reason *"Explicit PDF requested for … — switching paper from thermal to A4"*.
   - The `previewAtThermalWidth` escape hatch (L2377–2387) is gated on `documentType === "pos_receipt" | "pos_receipt_preview"`. Every other document type is excluded by design.
5. **PDF renderer builds A4.** `_shared/pdfGenerator.ts` → `PdfBuilder` receives `a4`, pageMargin 72pt, produces the observed A4 output. The renderer itself is paper-agnostic and *would* emit a 80mm-wide PDF if asked — it never gets the chance.
6. **UI reinforces the coercion.** `src/components/common/PrintSettingsPopover.tsx` L28–35 explicitly hides thermal from the per-print paper override, documenting *"rendering an A4 invoice as a tall narrow PDF preview is a category error"*.

So the pipeline is real; the paper value flows correctly; **the coercion is the authority that wins**, and the admin UI does not reflect that.

## Enterprise-pattern comparison (Phase 1 findings)

| Platform | Paper vs format | Thermal-width PDF? | Authority |
| --- | --- | --- | --- |
| Odoo | `paperformat` (dims) is orthogonal to report type (`ir.actions.report`). | **Yes** — receipt reports have their own paperformat and emit narrow PDFs for email/preview. | Report action + paperformat, per company. |
| SAP CC / Xstore / Dynamics 365 Commerce | Layout profile per document; format is transport (PDF/ESCPOS/ZPL). | Receipt PDFs are narrow-width by convention. | Store profile > document profile. |
| Square / Shopify / Toast / Lightspeed | Receipts are ESC/POS on device; email/archive uses narrow-column PDF. | **Yes** for archive/email. | Location settings. |
| QuickBooks / Xero | Business documents pinned to A4/Letter; thermal not exposed. | N/A | Company defaults. |

**Extracted principles**
- Paper size and render format are **orthogonal**; both are legal degrees of freedom.
- ESC/POS is a **transport**, not a substitute renderer, but the layout must match the paper. A narrow PDF is a valid *rendering* of a receipt-shaped document.
- One document model → many serializers (PDF/ESCPOS/HTML/ZPL/image). Coercion should reject **impossible** combinations, not **inconvenient** ones.

Measured against that: our coercion is too aggressive. It treats "narrow PDF of a receipt-style invoice" as illegal when it is actually the norm for wholesale/thermal-first businesses (the exact scenario ADR-0008 was written to unblock).

## Root-cause classification

- **Not** a renderer bug (`PdfBuilder` handles mm paper sizes).
- **Not** a lost value (resolver + policy row are correct).
- **Not** an abandoned feature (`resolvePolicy` + coercion + settings UI + tests are all live).
- **Is** an **architectural policy conflict**: the coercion rule "non-POS + thermal + explicit PDF → A4" collides with the admin UI's promise that the combination is valid, and with ADR-0008's stated goal of unifying wholesale invoices onto thermal hardware.
- **Is** a **UI/authority mismatch**: `PrintingSettings` exposes combinations that `coercePaperRenderMode` will silently reject. `PrintSettingsPopover` already hides them for per-print overrides — the admin surface is out of step.

## Remediation plan (smallest correct fix, preserves single-renderer architecture)

Two changes, both inside the existing pipeline. No new renderer, no new fetcher, no bypass.

### Step 1 — Make thermal-width PDF a **first-class** output for non-POS documents

Lift the POS-only gate around the `previewAtThermalWidth` branch so it applies to any document whose resolved policy is thermal + explicit PDF. Concretely, in `generate-document/index.ts` L2377–2387:

- Remove `isReceiptType` restriction.
- When `policy.paper_format ∈ {40mm,58mm,80mm}` **and** the caller's `explicitFormat === "pdf"`, set `effectiveFormat = "pdf"` and `effectivePaperOverride = policy.paper_format` so `PdfBuilder` runs in `density: "narrow"` at the correct mm width.
- `coercePaperRenderMode` keeps its role for the two *genuinely* illegal cases: (a) `escpos` requested on A4/Letter/A5 → coerce to 80mm, (b) `pos_receipt` on thermal + auto-print → ESC/POS.
- Update `coercePolicy.ts` so the "switch thermal → A4 on explicit PDF" branch fires **only** when the document type is on a `PDF_MUST_BE_WIDE` allow-list (statutory returns, payslips, tax certificates — already `assertStatutoryPaper`-pinned per ADR-0008). Everything else is allowed to render narrow.
- Extend `_shared/pdf/themes/accountantMono.ts` narrow-density branch (already 6pt margin) to be exercised by the invoice/statement/bill components, which already read `density` from the builder per `docs/printing-pipeline.md`.

### Step 2 — Make the admin UI reflect the coercion matrix

`PrintingSettings.tsx` should not offer combinations the platform will reject:

- Drive the `(paper × render_mode)` matrix from a shared exported constant (`LEGAL_COMBOS_BY_DOC_TYPE`) derived from `coercePolicy.ts`. Both `PrintingSettings` and `PrintSettingsPopover` import it — one source of truth.
- For statutory/pinned document types, disable thermal paper entirely with an inline "A4 required (regulator)" caption.
- For every other doc type, expose the full matrix now that Step 1 makes it real.
- Surface `X-Print-Policy-Coerced` + `X-Print-Policy-Coerce-Reason` (already emitted) in `ResolvedPrintPolicyPanel` for admin diagnostics on the settings page (currently only POS test-print uses it).

### Step 3 — Guards + tests

- Extend `supabase/tests/print_policies_resolve_test.sql` and `src/test/printing/print-policies-resolve.test.ts` with cases: `(sales_invoice, 80mm, pdf, explicit=pdf) → 80mm/pdf`, `(payslip, 80mm, pdf, explicit=pdf) → a4/pdf coerced`, `(pos_receipt, 80mm, pdf, explicit=pdf) → 80mm/pdf (preview)`.
- Add an architecture test: `PrintingSettings` and `PrintSettingsPopover` must both import `LEGAL_COMBOS_BY_DOC_TYPE`; string literals for paper/render mode outside that constant are disallowed (mirrors the existing rendering-ownership guards).
- Deno test for `_shared/pdf/PdfBuilder` at `paper=80mm density=narrow` proves the invoice components lay out without overflow.

### Step 4 — Handover

Update `.lovable/plan.md`:
- Mark Phase 1–3 + Milestones A/B/C.1/C.2 as previously completed (unchanged).
- Add **Phase 4 — Printer-profile authority reconciliation** with the three steps above.
- Note follow-ups: extend narrow-PDF density to statement/bill/estimate templates; audit `send-document-email` to confirm it consumes the same resolved policy (it already imports `resolvePolicy`, verify format propagation); consider ZPL as a third render_mode when the label-printing milestone lands.

## What we are **not** doing (and why)

- Not adding a second renderer or a "receipt-PDF" edge function — would violate the single-renderer invariant (ADR-0084/0085).
- Not deleting the coercion — the ESC/POS-vs-printable coercion is still correct.
- Not hardcoding A4 anywhere new — the whole point is to remove the last hidden A4 fallback for non-statutory docs.
- Not touching statutory pins (`assertStatutoryPaper`) — regulator-facing PDFs stay A4.

## Deliverables tracker

- [x] Architecture audit (this document).
- [x] Traced execution flow with file:line evidence.
- [x] Enterprise-pattern comparison.
- [x] Root-cause classification: **authority conflict / partial implementation** (UI exposes combinations the coercion rejects).
- [ ] Implementation of Steps 1–4 (awaiting approval).
