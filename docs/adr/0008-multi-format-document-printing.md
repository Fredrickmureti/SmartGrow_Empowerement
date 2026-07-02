# ADR-0008 — Multi-format document printing (paper-agnostic renderer + policy layer)

- Status: Accepted (2026-05-11)
- Context: see `docs/audit/2026-05-11-printing-architecture.md`
- Supersedes: none
- Related: ADR-0005 (fat edge functions)

## Decision

We adopt a **three-layer printing architecture** modelled on Odoo's
paperformat / report-action separation:

1. **Document model** (paper-agnostic). The `DocumentData` shape produced
   by the fetchers in `supabase/functions/generate-document/index.ts` is
   the canonical domain object for every printable document. Renderers
   consume it; no renderer fetches data.
2. **Paper format + render strategy.** A `paperFormat` ({ widthMm,
   heightMm | "auto" }) plus a `renderMode` (`pdf` | `escpos` | `html`)
   are resolved per request from: explicit override → user preference →
   `document_print_policies` row for (business, document_type, branch) →
   system default (A4 / pdf).
3. **Transport / destination.** Reuses the existing POS hardware stack:
   `src/services/hardware/transport/{Electron,LocalAgent,WebUSB}` and the
   `agent/` Node TCP raw-bytes path. No parallel transport is created.

## Why

Today there are two completely separate printing stacks (POS thermal vs.
A4 PDF for sales/purchase/finance). Wholesale and B2B businesses that
issue invoices, sales orders, or bills but print on thermal hardware
cannot use the platform end-to-end. The audit document records the exact
coupling points and how Odoo, NetSuite, SAP, QuickBooks, and Xero solve
the same problem. We adopt their common pattern instead of duplicating
either stack.

## Consequences

- `_shared/pdf/PdfBuilder` becomes paper-agnostic (mm-based sizing with
  named presets). `pageSize: "a4" | "letter"` is preserved as an alias so
  every existing call site keeps compiling and produces identical A4
  output.
- `_shared/pdf` components gain a `density: "wide" | "narrow"` flag they
  read from the builder so the same `LineItemsTable` / `TotalsBlock` /
  `RecipientBlock` works on A4 *and* 80 mm without forking templates.
- `generate-document` accepts an optional `paperFormat` and `renderMode`
  in its request body. Default behaviour (A4 PDF) is unchanged.
- `ReceiptEscPosBuilder` is promoted (later stage) to consume the
  canonical `DocumentData` shape so ESC/POS is fed by the same fetchers
  as PDF — no second invoice template.
- A new `document_print_policies` table (later stage) holds the
  per-business defaults; absence of a row preserves A4 PDF behaviour.

## Alternatives considered

- **Fork the POS receipt renderer for invoices.** Rejected: it doubles
  the template surface area and cements the existing duplication.
- **Add a parallel `generate-receipt-from-document` edge function.**
  Rejected: this is what Odoo deliberately avoids — paper choice is a
  policy, not a separate domain.
- **Render everything via headless HTML/Chromium.** Rejected: too heavy
  for an edge-function runtime and unnecessary now that pdf-lib supports
  arbitrary mm-based page sizes.

## Statutory exceptions

Some document types are NOT covered by the per-tenant policy resolver and
MUST remain A4 portrait regardless of any `document_print_policies` row.
These documents carry a `// STATUTORY PAPER PIN` sentinel comment in
their generator and call `assertStatutoryPaper("a4")` at the top of the
render path so a misconfigured policy never produces a non-compliant
filing.

| Generator | Document | Pinned because |
| --- | --- | --- |
| `generate-statutory-return` | PAYE / NSSF / NHIF / SHIF / Housing Levy returns | Filing portals (KRA, URA, TRA, etc.) reject anything but A4 PDF. |
| `generate-tax-certificate` | Annual employee tax certificates (P9 in Kenya, equivalents elsewhere) | Required for personal tax filing; auditors expect A4. |
| `generate-payslip-pdf` | Employee payslips | Pay-record evidence at labour inspections; A4 is the audit-safe default. |
| `generate-audit-certificate` | Internal audit / investigation certificates | Evidentiary attachment to regulator submissions. |

`download-tax-certificate` and `generate-localization-statutory-document`
are intentionally NOT pinned — the former only serves a previously-stored
A4 PDF, and the latter currently emits CSV only. If the localization
generator ever produces PDFs, it must call `assertStatutoryPaper`.
