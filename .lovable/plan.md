## Bills list — remove the legacy "Add Bill" popup dialog

The previous agent added `BillRecordPage` at `/purchases/bills/new` and marked "Bill · Create" as **Done** in `docs/design-system/audit/purchases.md`, but never removed the inline create `<Dialog>` from `src/pages/Bills.tsx`. Clicking "Add Bill" still opens the legacy popup instead of navigating to the new record page. The dialog ban guard didn't catch it because the guard only scans dedicated `Create*Dialog.tsx` files, not inline `<Dialog>` blocks inside list pages.

Cross-checked every other Purchases list page (POs, Credit Notes, Expenses, Purchase Returns, RFQs) — all of them correctly `navigate("…/new")`. Bills is the only regression.

### 1. Wire Bills.tsx to the record route

`src/pages/Bills.tsx`

- "Add Bill" button (line 693) → `navigate("/purchases/bills/new")` instead of `setShowDialog(true)`.
- `?action=create` deep link handler (~lines 300–305) → `navigate("/purchases/bills/new" + preserved query)` with `replace: true`, matching the pattern in `PurchaseOrders.tsx` and `Expenses.tsx`.
- Delete the entire inline `<Dialog>` block (lines ~994–1157) and all state / helpers that only fed it:
  - `showDialog`, `setShowDialog`
  - `formData`, `setFormData`, `resetForm`
  - `lineItems`, `setLineItems`, `addLineItem`, `updateLineItem`, `removeLineItem`, `calculateLineTotal`
  - `subtotal`, `totalTax`, `grandTotal`
  - `handleSubmit`, `isSubmitting`
  - Any imports that become unused: `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Select*`, `Label`, `Textarea`, `Input` (if unused elsewhere), `NumericInput`, `PackagedQtyCell`, `CustomFieldsSection`, `fetchContactDefaults`, `paymentTerms`, `products` (if only used by the dialog), `vendors` (keep if used by filters), `Plus`/`Trash2` (recheck usage).
- Keep everything else on the page untouched (row actions, bulk delete, payment history dialog, print/email, peek sheet).

### 2. Close the guard loophole

`src/test/architecture/purchases-record-dialog-ban.test.ts`

Add a second scan that also fails on any `src/pages/*.tsx` inside the Purchases surface (Bills, PurchaseOrders, Expenses, CreditNotes, PurchaseReturns, RFQs, VendorStatements, VendorPriceLists) containing a top-level `<Dialog ` whose `<DialogTitle>` matches `/^(Add|Create|New|Edit)\s+(Bill|Purchase Order|Expense|Credit Note|Return|RFQ|Vendor)/i`. Confirmation dialogs (`AlertDialog`) and print/email/payment dialogs stay allowed because they don't match those titles. This is what should have caught the Bills regression.

### 3. Audit trail

`docs/design-system/audit/purchases.md`

Add a short line under the RFQ close-out note explaining the Bills list-page cleanup and pointing at the strengthened guard test. Bill row stays **Done** (it now genuinely is).

### 4. Verification

- `bunx vitest run src/test/architecture/purchases-record-dialog-ban.test.ts`
- `tsgo` typecheck clean
- Playwright smoke: `/purchases/bills` → click "Add Bill" → URL is `/purchases/bills/new` and `BillRecordPage` renders (no popup); `/purchases/bills?action=create` also redirects to the record page.

### Out of scope

- No changes to `BillRecordPage`, `BillEditPage`, or the bill mutation pipeline.
- No changes to Payment / Email / Print / Bulk-Delete dialogs on the Bills page — those are correct `Dialog` usages.
- No other Purchases pages need edits (verified).
