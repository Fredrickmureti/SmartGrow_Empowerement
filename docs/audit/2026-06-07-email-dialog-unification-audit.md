# Email Dialog Unification Audit — 2026-06-07

## Trigger
User reported suspected duplication: bespoke email dialogs in Payroll,
Projects, and Timesheets bypassing the unified `SendDocumentDialog`
(AI assistant + extra-attachment) used by Sales / Purchases / POS.

## Method
Exhaustive sweep of every email-composition surface:
- All `*EmailDialog` components
- All `supabase.functions.invoke("send-*")` call sites
- All inline `showEmailForm` / hand-built HTML body patterns
- All `mailto:` links

## Findings

### Already unified on `SendDocumentDialog`
| Module | Status |
|---|---|
| Sales (Invoices, Estimates, SO, Returns, Credit Notes, Proforma, Delivery Notes, Customer Statements) | ✅ |
| Purchases (PO, Bills, Purchase Returns, Vendor Statements) | ✅ |
| POS receipts (`ReceiptPreviewDialog` → `SendDocumentDialog`) | ✅ |
| Payroll payslips, single + bulk (`PayrollRunDetailsDialog`, `sections.tsx`) | ✅ |
| Customer / Vendor Payments | ✅ |

Guarded by `src/test/architecture/single-email-dialog.test.ts`.

### No email send UI exists (so nothing to unify)
- Projects (`src/pages/projects/**`, `src/components/projects/**`)
- Timesheets (`src/pages/timesheets/**`)

### Legitimately separate surfaces (intentionally not unified)
- `EmailReportDialog` — report exports, no document id / contact recipient.
- `admin/email/ComposeEmailDialog` + `ComposeEmailTab` — platform-admin
  broadcast tool, not a tenant document send.
- System-notification edge functions (`send-invitation-email`,
  `send-leave-email`, `notify-po-confirmed`, `send-stock-alert-email`,
  `send-notification-email`, `send-tenant-ownership-transfer`) — event
  triggered, centralized via `send-email` transport per ADR 0023.

### Real duplication found and removed
`src/components/payments/ReceiptDialog.tsx` — a 700-line dialog with its
own inline email form: `showEmailForm` state, hand-built HTML body,
direct `supabase.functions.invoke("send-email", …)` with manual base64
PDF attachment. Bypassed `SendDocumentDialog` (no AI assistant, no
extra-attachment slot, no tenant sender-identity resolution per ADR 0023).

It was **dead code** — not imported anywhere in the project — left over
from the pre-unification era. The live receipt paths are
`ReceiptPreviewDialog` (POS) and `SendDocumentDialog` (Customer
Payments), both already correct.

## Actions taken
1. Deleted `src/components/payments/ReceiptDialog.tsx`.
2. Extended `src/test/architecture/single-email-dialog.test.ts`:
   - Asserts the file stays deleted.
   - Fails the build if any `src/components/**` file invokes
     `supabase.functions.invoke("send-email", …)` outside the
     admin-broadcast allowlist.
3. This audit document.

## Conclusion
The unification the user wanted was already complete for every live
surface. The remaining footgun (dead `ReceiptDialog`) is now removed and
guarded against reintroduction. No changes were needed to Payroll,
Projects, Timesheets, Sales, Purchases, or POS.
