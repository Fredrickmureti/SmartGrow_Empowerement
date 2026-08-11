# Purchases: action parity between row menus, peeks and full pages

## The inconsistency is real — here is the evidence

Confirmed by reading the code, not assumed:

- **Bills list row menu is hand-rolled.** `src/pages/Bills.tsx` (rows ~920-1027) builds its own dropdown with its own local handlers. It does *not* use `useBillActions`, even though that hook's header comment claims it is "rendered identically by the list row menu and the record page".
- **The two surfaces offer different vocabularies.**
  - List only: View Details (peek), Submit for Approval, Approve, Reject (return to draft), Post to Ledger, and a single combined **"Print / Preview"** item.
  - Full page only (`useBillActions`): **Preview** and **Print** as two separate actions, Match receipts, Void (with dialog), Create purchase return, Payment history.
  - So the bill's approval lifecycle is unreachable from the full page, and match/void/return are unreachable from the row menu.
- **"Print / Preview" and Preview+Print are not the same thing.** The list item calls `handlePrintBill` (`src/pages/Bills.tsx:291`), a duplicated copy of the snapshot → document record → print-intent pipeline that also lives in `useRecordPrint`. The record page's Preview opens the in-app document viewer; its Print queues to the print pipeline. One menu item cannot be both.
- **There is no Download action on any purchases document except the Vendor Statement** (`VendorStatementRecordPage.tsx:35`). Purchase Orders has an item *commented* "Print / Download PO" (`src/pages/PurchaseOrders.tsx:633`) that only prints. The only way to actually download a generated PDF today is the Document History panel.
- **Purchase Orders repeats the pattern**: `usePurchaseOrderActions` exists, but the list (`src/pages/PurchaseOrders.tsx` ~590-655) hand-rolls the same actions with a second local print handler.
- **Peek sheets expose no actions at all** (Bill, Purchase Order, Purchase Return, Vendor Credit Note) — by an old convention that pushed everything to the row menu.
- **Vendor Credit Note has no output actions anywhere**: `useVendorCreditNoteActions` is only edit / confirm / apply-to-bill / delete — no preview, print, email or download on either surface.

## What to build

### 1. A real Download action
Add a shared `useRecordDownload(kind)` for purchases, alongside `useRecordPrint`, that renders the document and saves the PDF locally (no printer routing). Add it as a `Download PDF` action in the `output` group for Bill, Purchase Order, Purchase Return, Vendor Credit Note, RFQ and Requisition, so Preview / Print / Download / Email are three distinct, always-present output actions instead of one ambiguous "Print / Preview".

### 2. Complete the action hooks
- `useBillActions`: add the approval lifecycle currently trapped in the list (Submit for approval, Approve, Reject, Post to ledger) plus Download, reusing the existing handlers moved out of `Bills.tsx`.
- `usePurchaseOrderActions`: add Preview and Download.
- `useVendorCreditNoteActions`: add Preview, Print, Download, Email.
- `usePurchaseReturnActions` and `useRFQActions`: add Preview (returns) and Download.

### 3. Make the list menus render the hook
Replace the hand-rolled dropdowns in `Bills.tsx` and `PurchaseOrders.tsx` (and the equivalents for returns, vendor credit notes, RFQs, requisitions) with the shared actions menu fed by the hook, and delete the duplicated local print handlers. The row menu and the full page then read from one array by construction.

### 4. Give the peeks the same actions
Pass the hook's actions to `PeekScaffold` for the purchases peek sheets, so a document opened as a drawer is not a dead end.

### 5. Guard it
Extend the document-workspace architecture test: for every purchases document, the list row menu, peek and record page must resolve their actions from the same hook, and no page may define a local print/download handler. Divergence becomes a failing test instead of a bug report.

## Behaviour notes

- Actions stay status-aware exactly as today (Post to ledger only pre-GL, Record payment only once posted, Delete admin + draft only).
- Preview = open in-app viewer. Print = queue through the print intent pipeline. Download = save the PDF. Email = send to the supplier. These four never collapse into one item.
- Destructive actions (Void, Cancel, Delete) stay at the bottom of the overflow.
- No business logic, RPC, or database change — presentation and wiring only. The existing handlers are moved, not rewritten.

## Technical detail

- New: `src/features/purchases/record/useRecordDownload.ts` (twin of `useRecordPrint.tsx`).
- Changed: `src/features/purchases/*/use*Actions.tsx` (bills, orders, returns, credit-notes, rfqs).
- Changed: `src/pages/Bills.tsx`, `src/pages/PurchaseOrders.tsx` and sibling list pages — local handler blocks removed, dropdown replaced by the shared actions menu.
- Changed: purchases `*PeekSheet.tsx` to accept and pass `actions`.
- Changed: `src/test/architecture/document-workspace-canonical.test.ts`.
