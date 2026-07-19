## The honest answer

Yes — what Enerpize does is the correct industry pattern, and our current flow conflates two things that must stay separate:

1. **The visual receipt** the cashier looks at on screen (an in-app card).
2. **The physical output** that goes to a device (thermal roll, A4 sheet, or a browser Chrome print dialog).

We currently drive both from the same server-rendered PDF pipeline, and we force that PDF to a thermal width even when the destination is a desktop browser. That's why we get either "a4 crammed into 80mm" or "a tall receipt with dead space" — we're printing a thermal artifact through a non-thermal transport.

Enerpize's flow you described is doing three separate things:

- **On-screen preview** = a styled HTML "receipt card" (not a PDF). That's the 80mm-looking panel with Cancel / Clone / Print. It is pure presentation, always looks crisp, and never depends on paper size.
- **Print action, no thermal bound** = open Chrome's native print dialog on an **A4/Letter invoice document** (a full-page invoice, not the 80mm receipt). The receipt shape is meant for a roll; a sheet printer gets a sheet-shaped invoice.
- **Print action, thermal bound** = send ESC/POS bytes straight to the roll printer, no dialog, no PDF.

The paper size is a property of the **target device**, not of the document. We've been treating "receipt" as a fixed 80mm artifact and then trying to make every transport render it, which is what makes the output look amateurish.

## Target behaviour

At the end of a POS sale, regardless of hardware state, we show the same in-app HTML **Receipt Card** panel (slide-down, styled like a real 80mm receipt, Cancel / Clone / Print). This panel is HTML only — no iframe, no PDF, no Chrome chrome — so it is always visually clean and identical on every screen.

The **Print** button then routes by resolved policy + bound hardware:

| Bound receipt device        | What Print does                                                                 |
| --------------------------- | ------------------------------------------------------------------------------- |
| Thermal 80/58/40mm printer  | Send ESC/POS bytes to the printer. No dialog. (unchanged)                       |
| A4/Letter printer (or none) | Open Chrome's native print dialog on a **full-page invoice PDF** (A4/Letter).   |
| User chose "Save as PDF"    | Download the A4/Letter invoice PDF.                                             |

Key rule: **we never send a thermal-shaped document to a sheet transport, and we never send a sheet-shaped document to a thermal transport.** The receipt-card HTML panel exists so the cashier always has a nice visual confirmation, decoupled from whichever transport actually runs.

## What changes in the code

Presentation-only work; the PDF and ESC/POS renderers built in T1–T5 stay as they are.

### 1. New in-app Receipt Card component

`src/components/pos/ReceiptCardPanel.tsx` — a pure HTML/Tailwind component that renders the sale using the existing `ReceiptDocumentModel` (already used by `PreviewRenderer`). Fixed narrow width (~360px), monospace body font, dashed dividers, org header, items table, totals block, payment lines, footer notes — the same look as the screenshot. No iframe, no PDF blob. Cancel / Clone / Print buttons in a sticky footer bar.

Replace the current PDF-iframe body of `src/components/pos/ReceiptPreviewDialog.tsx` with this card. The dialog stays; only its body changes.

### 2. Split "receipt" from "invoice" at the transport boundary

In `src/services/printing/PrintClient.ts`, the `receipt` intent currently always resolves to `escpos` and falls through to a PDF that was rendered at thermal width. Change the resolver so:

- `intent: 'receipt'` + a bound thermal device → ESC/POS (unchanged).
- `intent: 'receipt'` + no thermal device (or policy resolves to `pdf` on a sheet profile) → render `documentType: 'pos_invoice'` (full A4/Letter invoice layout), not `pos_receipt` at 80mm. Route through `printPdfInPage(blob)` so Chrome's native print dialog opens on an A4 page — exactly the Enerpize behaviour you saw.

The `pos_invoice` document type already exists as a first-class sheet template in `supabase/functions/_shared/pdf`; we just weren't selecting it on the no-thermal path.

### 3. Wire the Print button in the new card

`ReceiptCardPanel`'s Print button calls `printClient.print({ intent: 'receipt', businessId, branchId, documentType: 'pos_receipt', documentId })`. `PrintClient` picks the right document type + transport per the table above. Cancel just closes the dialog. Clone re-opens the POS session pre-filled from `TransactionSummaryView`'s existing clone hook.

### 4. Kill the "tall PDF" fallback path

Remove the `SafePdfViewer`/iframe usage inside `ReceiptPreviewDialog`. The PDF now only ever exists at the moment of printing — never as an on-screen artifact. This makes the "long ass space at the bottom" impossible by construction, because nothing renders a thermal PDF to the screen anymore.

### 5. Guardrail test

Add `src/test/pos/receipt-transport-shape.test.ts`:

- Thermal bound → `PrintClient` requests `pos_receipt` (thermal).
- No thermal bound → `PrintClient` requests `pos_invoice` (A4/Letter).
- On-screen preview never instantiates a PDF blob.

## Out of scope

- No changes to ESC/POS byte generation or the T1–T5 continuous-paper work.
- No changes to statutory documents (they stay sheet-locked).
- No new server-side templates — `pos_invoice` already exists.

## Files touched

- `src/components/pos/ReceiptPreviewDialog.tsx` (body swap)
- `src/components/pos/ReceiptCardPanel.tsx` (new)
- `src/services/printing/PrintClient.ts` (intent → documentType branching on hardware state)
- `src/test/pos/receipt-transport-shape.test.ts` (new)
- `docs/audit/2026-05-11-printing-architecture.md` (Section 11: "Receipt card vs. transport artifact")

Ready to implement on approval.