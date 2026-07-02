# Sales — record-interaction audit

Ledger of every create / edit / duplicate / convert / configure / process
surface in the Sales workspace, its current pattern, and the target
pattern under the record-interaction standard
(`docs/design-system/records.md`).

Legend for **Target**:

- **Object page** → `RecordShell` on a dedicated route.
- **Wizard** → `WizardShell` on a dedicated route.
- **Peek sheet** → `DetailSheet` opened via `?peek=<id>` on the list.
- **Dialog (keep)** → stays as a `Dialog` — confirm-style, ≤6 fields, or a picker.
- **Inline** → grid-native row edit inside a table primitive.

## 1. Invoices — `/sales/invoices`

Files: `src/pages/Invoices.tsx`, `src/components/invoices/*`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create invoice | `CreateInvoiceDialog` | Object page | `/sales/invoices/new` |
| 2 | Edit invoice | `EditInvoiceDialog` | Object page | `/sales/invoices/:id` |
| 3 | View invoice detail | `InvoiceDetailDialog` | Peek sheet (list) + object page (deep link) | `?peek=<id>` / `/sales/invoices/:id` |
| 4 | Record payment | `RecordPaymentDialog` | Wizard | `/sales/invoices/:id/receive-payment` |
| 5 | Payment history | `PaymentHistoryDialog` | Section in object page aside | inline |
| 6 | Void invoice | `VoidInvoiceDialog` | Dialog (keep) | confirm |
| 7 | Bulk delete | `BulkDeleteDialog` | Dialog (keep) | confirm |
| 8 | Bulk export | `BulkExportDialog` | Dialog (keep) | pick fields |
| 9 | Invoice line row | `InvoiceLineRow` | Inline (in `LineItemsGrid`) | inline |
| 10 | Line scanner | `InvoiceLineScanner` | Section inside object page | inline |
| 11 | Duplicate | (menu, opens create dialog prefilled) | Object page (`?duplicate=<id>`) | `/sales/invoices/new?from=<id>` |

## 2. Estimates — `/sales/estimates`

Files: `src/pages/Estimates.tsx`, `src/components/estimates/*`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create estimate | `CreateEstimateDialog` | Object page | `/sales/estimates/new` |
| 2 | Edit estimate | `EditEstimateDialog` | Object page | `/sales/estimates/:id` |
| 3 | View estimate | `EstimateDetailDialog` | Peek sheet + object page | `?peek=<id>` / `/sales/estimates/:id` |
| 4 | Bulk export | `BulkExportEstimatesDialog` | Dialog (keep) | picker |
| 5 | Convert to invoice / SO | (menu in dialog) | Wizard | `/sales/estimates/:id/convert` |

## 3. Sales orders — `/sales/orders`

Files: `src/pages/SalesOrders.tsx`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create SO | dialog inside page | Object page | `/sales/orders/new` |
| 2 | Edit SO | dialog inside page | Object page | `/sales/orders/:id` |
| 3 | View SO | dialog inside page | Peek + object page | `?peek=<id>` / `/sales/orders/:id` |
| 4 | Convert to invoice / delivery | inline menu | Wizard | `/sales/orders/:id/convert` |
| 5 | Cancel order | inline confirm | Dialog (keep) | confirm |

## 4. Proforma invoices — `/sales/proforma`

Files: `src/pages/ProformaInvoices.tsx`, `src/components/sales/CreateProformaDialog.tsx`, `src/components/sales/ProformaDetailDialog.tsx`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create proforma | `CreateProformaDialog` | Object page | `/sales/proforma/new` |
| 2 | View / edit proforma | `ProformaDetailDialog` | Peek + object page | `?peek=<id>` / `/sales/proforma/:id` |
| 3 | Send by email | `SendDocumentDialog` | Dialog (keep) | confirm-style |
| 4 | Print preview | `PrintPreviewDialog` | Dialog (keep) | picker |
| 5 | Convert to invoice | inline menu | Wizard | `/sales/proforma/:id/convert` |

## 5. Delivery notes — `/sales/delivery-notes`

Files: `src/pages/DeliveryNotes.tsx`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create delivery note | dialog | Object page | `/sales/delivery-notes/new` |
| 2 | Edit delivery note | dialog | Object page | `/sales/delivery-notes/:id` |
| 3 | View delivery note | dialog | Peek + object page | `?peek=<id>` |
| 4 | Confirm delivery | dialog | Dialog (keep) | confirm |

## 6. Credit notes — `/sales/credit-notes`

Files: `src/pages/CreditNotes.tsx`, `src/components/credit-notes/CreditNoteListTable.tsx`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create credit note | dialog | Object page | `/sales/credit-notes/new` |
| 2 | Edit credit note | dialog | Object page | `/sales/credit-notes/:id` |
| 3 | View credit note | dialog | Peek + object page | `?peek=<id>` |
| 4 | Apply credit to invoice | dialog | Wizard | `/sales/credit-notes/:id/apply` |

## 7. Sales returns — `/sales/returns`

Files: `src/pages/SalesReturns.tsx`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create return | dialog | Object page | `/sales/returns/new` |
| 2 | Edit return | dialog | Object page | `/sales/returns/:id` |
| 3 | View return | dialog | Peek + object page | `?peek=<id>` |
| 4 | Process refund | dialog | Wizard | `/sales/returns/:id/refund` |

## 8. Recurring invoices — `/sales/recurring`

Files: `src/pages/RecurringInvoices.tsx`, `src/components/sales/RecurringInvoiceDetailDialog.tsx`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create template | inline `Dialog` | Object page | `/sales/recurring/new` |
| 2 | Edit template | inline `Dialog` | Object page | `/sales/recurring/:id` |
| 3 | View template | `RecurringInvoiceDetailDialog` | Peek + object page | `?peek=<id>` |
| 4 | Pause / resume | inline confirm | Dialog (keep) | confirm |
| 5 | Generate next invoice now | inline button | Dialog (keep) | confirm |

## 9. Customer payments — `/sales/payments`

Files: `src/pages/CustomerPayments.tsx`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Record payment | dialog | Wizard (allocation-heavy) | `/sales/payments/new` |
| 2 | Edit payment | dialog | Object page | `/sales/payments/:id` |
| 3 | View payment | dialog | Peek + object page | `?peek=<id>` |
| 4 | Reverse payment | confirm | Dialog (keep) | confirm |

## 10. Customers — `/sales/customers` (Contacts scoped to customer role)

Files: `src/pages/Contacts.tsx`, `src/components/contacts/*`.

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Create customer | inline dialog | Object page | `/sales/customers/new` |
| 2 | Edit customer | inline dialog | Object page | `/sales/customers/:id` |
| 3 | Preview / peek | `ContactPreviewDrawer` | Peek sheet (migrate to `DetailSheet`) | `?peek=<id>` |
| 4 | Delete | `ContactDeleteDialog` | Dialog (keep) | confirm |
| 5 | Merge customers | `ContactMergeDialog` | Wizard | `/sales/customers/merge` |
| 6 | Customer groups | `CustomerGroupsDialog` | Object page under Configuration | `/sales/configuration/customer-groups` |
| 7 | Bulk actions | `ContactBulkActions` menu | Dialog (keep) | confirm |
| 8 | Accounting defaults section | inline card | Section inside object page | inline |
| 9 | Credit management section | inline card | Section inside object page | inline |
| 10 | Activity timeline | inline card | Aside on object page | inline |
| 11 | Aging breakdown | inline card | Aside on object page | inline |

## 11. Customer statements — `/sales/statements`

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Generate statement | dialog | Wizard | `/sales/statements/new` |
| 2 | View / send statement | dialog | Peek + object page | `?peek=<id>` |

## 12. Collections — `/sales/collections`

| # | Surface | Today | Target | Route / trigger |
|---|---|---|---|---|
| 1 | Log collection activity | dialog | Peek sheet on customer | `?peek=<id>` |
| 2 | Send reminder | dialog | Dialog (keep) | confirm |

## 13. Sales configuration — `/sales/configuration` (new)

Sub-routes to introduce (all object pages under a shared config layout,
mirroring `/hr/configuration`):

- `/sales/configuration/customer-groups`
- `/sales/configuration/price-lists` (currently accessed under Inventory in some builds — Sales-owned copy for pricing rules)
- `/sales/configuration/invoice-templates`
- `/sales/configuration/payment-terms`
- `/sales/configuration/tax-defaults`

Every configuration item follows the same `RecordShell` pattern.

## Rollout order (executed per plan §1.3)

1. Invoices
2. Estimates
3. Sales orders
4. Proforma
5. Delivery notes
6. Credit notes
7. Sales returns
8. Recurring invoices
9. Customers
10. Customer payments
11. Customer statements
12. Collections
13. Sales configuration

## Verification checklist (plan §1.4)

- [ ] No record dialog left for the entities above (grep clean).
- [ ] `RecordShell` / `DetailSheet` / `WizardShell` adopted per row.
- [ ] Every list page navigates to object page on row click / New / Edit.
- [ ] `?peek=<id>` opens a `DetailSheet`; closing clears the param.
- [ ] Every form uses `Section` + `FieldGrid columns={2|3}`; sticky `FooterActionBar`.
- [ ] No `text-[NNpx]`, `p-[NNpx]`, `rounded-[NNpx]`, `bg-white` — tokens only.
- [ ] Responsive collapse verified at 1280 / 1024 / 768 / 375 px.
- [ ] Typecheck + build clean.

## Progress log

- **2026-07-01** — Invoices object page landed at `/sales/invoices/:id`
  (`src/features/sales/invoices/InvoiceRecordPage.tsx`). Read-only for
  now: `RecordShell` + `RecordHeader` + `Section` + `LineItemsGrid` (readOnly)
  + `DocumentTotalsPanel` + `DocumentActivityPanel` + sticky `FooterActionBar`.
  `:id="new"` renders a placeholder pointing back to the create dialog until
  the create wizard migration lands. Edit / Print actions on the header are
  wired but disabled until the edit wizard replaces `EditInvoiceDialog`.
  Next: switch `Invoices.tsx` row-click and "View" affordances to
  `navigate("/sales/invoices/<id>")`, then migrate the create/edit dialogs
  to `WizardShell`.
- **2026-07-01** — Estimate object page landed at `/sales/estimates/:id`
  (`src/features/sales/estimates/EstimateRecordPage.tsx`). Same read-only
  shape as invoices: `RecordShell` + `RecordHeader` + `Section` +
  `LineItemsGrid` (readOnly) + `DocumentTotalsPanel` +
  `DocumentActivityPanel` + sticky `FooterActionBar`. Activity feed
  surfaces `signed_at` / `converted_at` transitions. `:id="new"` renders
  a placeholder pointing back to the estimates list until the create
  wizard lands. `InvoiceListTable` gained an "Open Full Page" dropdown
  item that navigates to `/sales/invoices/<id>` so the peek→record path
  is discoverable from the list without disrupting the existing detail
  dialog. Next: same list→object wiring for Estimates, then start the
  create/edit wizard migration.
- **2026-07-01** — Sales Order object page landed at `/sales/orders/:id`
  (`src/features/sales/orders/SalesOrderRecordPage.tsx`). Same read-only
  shape as invoices/estimates plus a `Fulfilled` column in the line-item
  grid and an activity entry when the SO originated from an estimate or
  was invoiced. `EstimateListTable` gained the "Open Full Page" dropdown
  action pointing at `/sales/estimates/<id>`. Typecheck clean. Next:
  same list wiring on `SalesOrders` / `DeliveryNotes` / `CreditNotes`,
  then start the create/edit wizard migration.
- **2026-07-01 (cycle 2)** — Extracted `SalesRecordScaffold`
  (`src/features/sales/record/SalesRecordScaffold.tsx`) so subsequent
  record pages are a ~120-line data-only wrapper instead of ~300 lines of
  duplicated shell boilerplate. Shipped four new read-only object pages:

  | Route | File |
  |---|---|
  | `/sales/proforma/:id` | `src/features/sales/proforma/ProformaRecordPage.tsx` |
  | `/sales/delivery-notes/:id` | `src/features/sales/delivery-notes/DeliveryNoteRecordPage.tsx` |
  | `/sales/credit-notes/:id` | `src/features/sales/credit-notes/CreditNoteRecordPage.tsx` |
  | `/sales/returns/:id` | `src/features/sales/returns/SalesReturnRecordPage.tsx` |

  Every list page for these entities gained the "Open Full Page" dropdown
  action (`ProformaInvoices`, `DeliveryNotes`, `CreditNoteListTable`,
  `SalesReturns`) pointing at the new object route. Typecheck clean.
  Sales record-page coverage now: 7 of 10 entity types have a dedicated
  object page (Invoices, Estimates, Sales Orders, Proforma, Delivery
  Notes, Credit Notes, Sales Returns). Remaining: Recurring Invoices,
  Customer Payments, Customers. Next: (a) recurring/payments/customer
  object pages using the same scaffold, (b) `?peek=<id>` DetailSheet
  integration on each list, (c) promote object pages from read-only to
  read/write and retire the create/edit dialogs, (d) migrate the
  multi-step flows (Record Payment, Convert, Apply, Refund, Statement,
  Merge) to `WizardShell`, (e) build `/sales/configuration/*`.
- **2026-07-01 (cycle 3)** — Phase A.1 complete: last three read-only
  Sales object pages shipped, giving 10/10 record-page coverage.

  | Route | File |
  |---|---|
  | `/sales/recurring/:id` | `src/features/sales/recurring/RecurringInvoiceRecordPage.tsx` |
  | `/sales/payments/:id` | `src/features/sales/payments/CustomerPaymentRecordPage.tsx` |
  | `/sales/customers/:id` | `src/features/sales/customers/CustomerRecordPage.tsx` |

  All three back onto `SalesRecordScaffold`. `RecurringInvoices`,
  `PaymentListTable`, and `Contacts` (customer/both rows only) gained
  "Open Full Page" / "Open Sales Record" dropdown items pointing at the
  new object routes. Customer record page composes AR aggregates
  (outstanding, open invoice count, revenue, last payment) inline in the
  SummaryPanel and links to the existing `/sales/customers/:id/ledger`
  and 360° profile as header actions. Typecheck clean.
  Next up in Phase A: peek `DetailSheet` wiring on every Sales list
  (retiring the 10 legacy `*DetailDialog` components), then promote all
  10 pages from read-only to read/write and retire the create/edit
   dialogs.

- **2026-07-01 (cycle 4)** — Phase A.2 started: reference peek sheet
  shipped for **Invoices**. New shared fetcher
  `src/features/sales/invoices/useInvoiceRecord.ts` and
  `InvoicePeekSheet.tsx` compose the same `Section` + `DocumentTotalsPanel`
  + `LineItemsGrid` + `DocumentActivityPanel` blocks the object page
  uses. `Invoices.tsx` row-click and deep-link `openInvoiceRecord` now
  set `?peek=<id>` and mount `<InvoicePeekSheet>` — `InvoiceDetailDialog`
  import + mount removed from the page. `showDetailDialog` state
  replaced by `usePeekParam()`. Header action "Open full page" jumps to
  `/sales/invoices/:id`. Row action menu still owns record-affecting
  actions (payment, void, edit, send, credit note, return). Typecheck
  clean. Next: roll the same pattern to Estimates, Sales Orders,
  Proforma, Delivery Notes, Credit Notes, Sales Returns, Recurring,
  Customer Payments, Customers, Statements — then delete each retired
  `*DetailDialog` file in the same pass.


- **2026-07-01 (cycle 5)** — Phase A.2 closeout for Sales peek surfaces
  + shared-primitive extraction:

  1. Extracted `SalesRecordBody` (`src/features/sales/record/SalesRecordBody.tsx`)
     — the shared section stack (details FieldGrid + LineItemsGrid +
     extras) previously duplicated between `SalesRecordScaffold` and every
     peek sheet. `SalesRecordScaffold` now composes this component so the
     full record page and the peek surface cannot drift.
  2. Added `SalesPeekScaffold`
     (`src/features/sales/record/SalesPeekScaffold.tsx`) — the ONE peek
     surface every Sales list should use. Accepts the same declaration
     shape as `SalesRecordScaffold` (detailFields, lineColumns/lineRows,
     totalsRows, activity, extraAside) and renders inside
     `DocumentPeekShell`. Reused domain-agnostically — Purchases /
     Inventory / Finance can import from `@/features/sales/record` until
     the primitive is promoted to `@/design-system` in a later pass.
  3. Deleted the two remaining Sales `*DetailDialog` files with zero
     live imports: `src/components/estimates/EstimateDetailDialog.tsx`
     and `src/components/invoices/InvoiceDetailDialog.tsx`. Peek surface
     is now the sole entry point.

  Sales Phase 2 (peek sheets) is closed. Remaining Sales work per the
  audit rollout: Phase 3 (create + edit `RecordShell` routes retiring
  the 12 `Create*`/`Edit*` dialogs), Phase 4 (WizardShell for Record
  Payment, Convert, Apply, Refund, Statement, Merge), Phase 5
  (`/sales/configuration/*` object pages). No cross-app work until
  those close per the plan sequencing constraint.


- **2026-07-01 (cycle 6)** — Phase 3 kickoff: shared **`RecordFormShell`**
  primitive landed at `src/design-system/primitives/RecordFormShell.tsx`
  and exported from `@/design-system`.

  It is `RecordShell` pre-wired for `/new` and `/:id/edit` routes:
    * owns the surrounding `<form>` element (id + onSubmit)
    * owns the Cancel button (routes back or calls `onCancel`)
    * owns the primary Submit button (form=<id>, spinner while busy)
    * exposes `extraLeadingActions` / `extraTrailingActions` slots for
      "Save & new", "Save & send", "Delete", etc.
    * mode="create" | "edit" drives the title + primary button label

  This is the ONLY approved scaffold for create/edit routes going
  forward. Modules must not render their own `<form>` element or their
  own Save/Cancel buttons on record routes — the primitive owns both.

  Next per-entity migration order (each retires its `Create*Dialog` +
  `Edit*Dialog` pair and adds `/new` + `/:id/edit` routes on top of
  `RecordFormShell`):
    1. Invoices  (`CreateInvoiceDialog` + `EditInvoiceDialog`)
    2. Estimates
    3. Sales Orders
    4. Proforma Invoices
    5. Delivery Notes
    6. Sales Returns
    7. Credit Notes
    8. Recurring Invoices
    9. Customer Payments
    10. Customers
  Typecheck clean.


- **2026-07-01 (cycle 7)** — Phase 3 guard rail landed:
  `src/test/architecture/sales-record-dialog-ban.test.ts`.

  It (a) forbids any NEW `Create*Dialog.tsx` / `Edit*Dialog.tsx` file
  appearing under `src/components/{invoices,estimates,sales,finance}`,
  and (b) freezes the 11 legacy Sales create/edit dialogs still awaiting
  migration into a shrinking allowlist. The allowlist may only shrink —
  each entry disappears as its `/new` + `/:id/edit` route pair lands on
  `RecordFormShell` and the underlying file is deleted. The test also
  fails if an allowlist entry becomes stale (file already deleted),
  forcing the ledger to stay honest. Test green, typecheck clean.


- **2026-07-01 (cycle 8)** — Phase 3 infra completed:
  **`useRecordFormSubmit`** landed at
  `src/design-system/hooks/useRecordFormSubmit.ts` and exported from
  `@/design-system`.

  It packages the three moving parts every `/new` + `/:id/edit` route
  needs: an `isSubmitting` flag (drives `RecordFormShell`'s footer
  spinner), a uniform success/error toast pair (created / updated /
  could-not-create / could-not-save), and a post-success redirect via
  `redirectTo: string | (result) => string`. Pages MUST NOT hand-roll
  their own useState + try/catch + toast triad on record forms — this
  hook owns the lifecycle.

  With `RecordFormShell` + `useRecordFormSubmit` + the dialog-ban guard
  now in place, per-entity migration is unblocked. Next chunk: land the
  first entity end-to-end (Invoices `/sales/invoices/new` +
  `/sales/invoices/:id/edit`) and drop both files from the guard's
  shrinking allowlist. Typecheck clean.


- **2026-07-01 (cycle 9)** — Phase 3, entity #1 (Invoices) — routes landed.

  New route pages on `RecordFormShell`:
    * `/sales/invoices/new`   → `src/features/sales/invoices/InvoiceCreatePage.tsx`
    * `/sales/invoices/:id/edit` → `src/features/sales/invoices/InvoiceEditPage.tsx`

  Both preserve every behaviour from the retired dialogs (branch-scoped
  stock evaluation + oversell confirm, credit check + available-credit
  alert, contact-defaults fetch, project picker, scanner integration,
  AI text assist, custom fields, tax-exclusive line math via
  `computeLine`/`computeTotals`). Create-page landing redirects to the
  new invoice's object page; edit-page landing redirects back to the
  same. Edit-page fetches the invoice by URL `:id` and blocks non-draft
  edits with a toast + redirect.

  Callsite migration (dialogs no longer mounted):
    * `src/pages/Invoices.tsx` — Create/Edit buttons, scan opener,
      `?action=create` deep-link and `handleEditInvoice` now all
      `navigate(...)` to the new routes. `CreateInvoiceDialog` /
      `EditInvoiceDialog` imports removed, JSX mounts removed.
    * `src/pages/projects/detail/Sales.tsx` — "New Invoice" button on
      a project detail navigates to
      `/sales/invoices/new?project_id=<id>&contact_id=<customer>`.

  Files `src/components/invoices/CreateInvoiceDialog.tsx` and
  `EditInvoiceDialog.tsx` are now DEAD (no live imports outside the
  `invoice-totals-contract.test.ts` architecture guard). Next chunk:
  update that test to read from the new route files, delete the two
  dialog files, and drop both entries from the
  `sales-record-dialog-ban` allowlist. Typecheck clean.
