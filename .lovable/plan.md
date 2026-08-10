# Document Actions Parity: Full Page = Row Menu

## What I confirmed (not assumed)

Your report is accurate. Verified in code:

- `InvoiceRecordPage` passes only `onPreview` and `onPrint` to `RecordScaffold`. It never passes `onEdit`, and `RecordScaffold` renders the Edit button as `disabled={!onEdit}` — so Edit on the invoice full page is permanently dead.
- The invoice row menu (`InvoiceListTable`) carries 14 actions the full page does not offer: Preview, Print, Send via Email, Edit, Confirm & Release Stock, Confirm+Send, Record Payment, Payment History, View Receipt, Create Credit Note, Create Sales Return, Void, Delete, Open Full Page. The full page offers 4 (Back, Preview, Print, disabled Edit).
- `InvoicePeekSheet` deliberately stays read-only ("all record-affecting actions remain with the list's row action menu") — that convention is what leaked into the full page.
- The gap is systemic across document record pages:
  - **No Edit at all:** Invoice, Credit Note, Estimate, Sales Order, Proforma, Recurring Invoice, Sales Return, Delivery Note, Customer Payment, Bill, Vendor Statement, RFQ.
  - **Edit wired:** Purchase Order, Vendor Credit Note, Purchase Return only.
  - Proforma, Recurring Invoice and Sales Return pass no actions whatsoever — they get the bare default cluster.
- Lifecycle actions (confirm, void, email, record payment, convert) live inline in the list page components (`src/pages/Invoices.tsx` and siblings, 500–850 lines each) as local handlers bound to local dialog state, so they are currently impossible to reuse from a record page without extraction.

## What to build

A single per-document **action set** that both the list row menu and the full page render, so the two can never drift again.

### 1. Action descriptor in the design system
Add `DocumentAction` (id, label, icon, tone, `disabled`/`hidden` predicate, handler) and a `DocumentActionsBar` that renders the first 2–3 actions as buttons and the rest in a "More" overflow menu, sized down on mobile. `RecordScaffold` gains an `actions?: DocumentAction[]` prop that feeds the header cluster; `PeekScaffold` accepts the same array (opt-in per document, so the peek can stay lean where you want it).

### 2. Extract each document's actions into a hook
For each document kind, one `use<Doc>Actions(record)` hook that owns the handlers *and* the dialogs they open (void, delete-confirm, payment, email). The list page and the record page both call it. No handler logic gets duplicated or rewritten — it moves out of the page component and is re-consumed by it.

### 3. Sweep, in dependency order
- **Phase A — Sales core:** Invoice, Estimate, Sales Order, Credit Note. These have the richest menus and cover the reported bug.
- **Phase B — Sales remainder:** Proforma, Delivery Note, Sales Return, Recurring Invoice, Customer Payment.
- **Phase C — Purchases:** Bill, Purchase Order, Purchase Return, Vendor Credit Note, Requisition, RFQ, Contract, Vendor Statement (normalise the three that hand-roll `headerActions` onto the shared bar).

### 4. Guard it
Extend `src/test/architecture/document-workspace-canonical.test.ts` with a rule: a record page may not pass a hand-rolled `headerActions` cluster, and every document with a list row menu must expose the same action ids through its actions hook. That turns "the full page is missing actions" into a failing test rather than a bug report.

## Behaviour notes

- Actions stay status-aware exactly as they are in the row menu today (e.g. Edit only on `draft`, Record Payment only when a balance is due). Where an action is not applicable it is hidden, not shown greyed out — except Edit on a posted document, which stays visible and disabled with a tooltip explaining why.
- Destructive actions (Void, Delete) sit at the bottom of the overflow menu, never as top-level buttons.
- No change to any business logic, RPC, or database object — this is presentation and wiring only.

## Technical detail

- New: `src/design-system/records/DocumentActions.tsx` (+ types export from `records/index.ts`).
- Changed: `RecordScaffold` header cluster, `PeekScaffold` optional actions prop.
- New per-domain hooks under each feature folder, e.g. `src/features/sales/invoices/useInvoiceActions.tsx`.
- Changed: list pages drop their local handler blocks in favour of the hook; row-menu components take the action array instead of ~14 individual callback props.
