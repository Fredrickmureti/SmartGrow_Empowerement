## Implementation plan

### 1. Correct the Purchases handoff before starting Inventory

**Goal:** make `/purchases/bills/new` a real create surface, not a read-only record lookup with `id === ""`.

- Replace the current Bills `/new` route target with a dedicated create page built on the existing enterprise record form pattern.
- Reuse the existing Bills create logic that was removed from `src/pages/Bills.tsx` where practical, but place it in a full-page `RecordFormShell`/record route instead of a dialog.
- Keep Bills list behavior intact:
  - `Add Bill` navigates to `/purchases/bills/new`.
  - `/purchases/bills?action=create&contact_id=...` redirects to `/purchases/bills/new?contact_id=...`.
  - Existing bill view remains `/purchases/bills/:id`.
  - Existing bill edit remains `/purchases/bills/:id/edit`.
- Fix route ordering/imports if needed so `bills/new` cannot fall through to `bills/:id`.
- Update Purchases audit notes only to reflect the truth: Bill create is complete only after the create page works.

### 2. Strengthen Purchases enforcement

**Goal:** prevent the exact regression from returning.

- Keep the existing Purchases dialog-file ban.
- Keep/repair the inline list-page scan that rejects `<DialogTitle>Add/Create/New/Edit ...</DialogTitle>` on Purchases list pages.
- Add an assertion that Bills `/new` is not mounted to the read-only `BillRecordPage` route target.
- Verify the guard fails for inline create/edit dialogs while allowing payment, print, email, preview, and confirmation dialogs.

### 3. Start Inventory migration with the highest-impact record flows

**Goal:** move Inventory away from modal CRUD and into the same enterprise architecture used by HR/Payroll, Sales, and Purchases.

Initial Inventory surfaces confirmed as legacy or partial:

- `src/pages/Products.tsx`
  - Add/Edit Product dialog.
  - Product detail dialog/panel pattern.
  - `?action=create`, `?createWithCode`, scan-to-onboard, and `?selected=` deep links still open dialogs.
- `src/pages/Warehouses.tsx`
  - Add/Edit Warehouse dialog.
  - Create Stock Transfer dialog.
- `src/pages/Inventory.tsx`
  - Create Stock Adjustment dialog.
  - Several drawer/detail surfaces for warehouse stock, movements, source docs, and adjustment details need classification as `PeekScaffold` or route object pages.
- `src/pages/inventory/Transfers.tsx`
  - New Stock Transfer dialog.
  - Transfer detail drawer.
- `src/pages/inventory/ScrapRecording.tsx`
  - Record Scrap/Waste dialog.
- `src/pages/inventory/PhysicalCount.tsx`
  - Already closer to a workspace, but should be formalized as a routed `WizardShell`-style count workspace.
- `src/pages/inventory/UomManagement.tsx`
  - UoM category and unit dialogs are small configuration forms; migrate to `DetailSheet` rather than object pages.

### 4. Inventory phase 1: product master records

**Goal:** modernize the central Inventory master record first.

- Add product create/edit routes:
  - `/inventory-app/products/new`
  - `/inventory-app/products/:id/edit`
  - `/inventory-app/products/:id`
- Build product create/edit on enterprise form primitives:
  - `RecordFormShell` or `RecordShell` + `FooterActionBar`
  - `Section`, `FieldGrid`, `FieldCell`, `FieldGroup`
  - shared product field component to avoid duplicating the existing long form
- Preserve critical integrations:
  - category selection
  - image upload
  - tax/compliance fields
  - product accounts
  - identifiers/barcodes
  - packaging editor
  - opening stock/warehouse handoff
  - scanner onboarding with `createWithCode`
- Change Products list actions:
  - Add → route
  - Edit → route
  - row click/view → record page or `?peek=<id>` depending on existing UX fit
  - `?action=create`, `?createWithCode`, and scan miss → route-based create flow
  - `?selected=` → product record/peek instead of dialog

### 5. Inventory phase 2: warehouse, transfer, adjustment, scrap, and count workflows

**Goal:** migrate transactional Inventory documents after the product foundation is stable.

- Warehouses:
  - create/edit via route or `DetailSheet` depending on final field count and business complexity; current form is more than six fields, so prefer routes.
  - object/peek page for warehouse stock context.
- Stock transfers:
  - `/inventory-app/transfers/new`
  - `/inventory-app/transfers/:id`
  - preserve dispatch/receive/cancel lifecycle actions.
  - migrate transfer line scanner into the route workspace.
- Stock adjustments:
  - `/inventory-app/adjustments/new`
  - `/inventory-app/adjustments/:id`
  - preserve branch/warehouse scoping, reason-to-offset-account preview, GL posting, reversal workflow.
- Scrap:
  - `/inventory-app/scrap/new` as a focused process route using the existing `record_scrap_atomic` RPC.
- Physical count:
  - convert the current inline workspace into a formal routed `WizardShell` at `/inventory-app/count/new` while preserving scanner counting and variance application.
- UoM configuration:
  - replace category/unit dialogs with `DetailSheet` configuration surfaces, preserving delete confirmations.

### 6. Add Inventory enforcement and update the audit ledger

**Goal:** make the migration durable.

- Extend or create an Inventory architecture guard that bans new Inventory `Create*Dialog`, `Edit*Dialog`, `*DetailDialog`, and legacy record drawers under Inventory/Product/Warehouse surfaces.
- Add an inline list-page scan for Inventory pages similar to the Purchases guard.
- Update `docs/design-system/audit/inventory.md` after each migrated surface with true status only.
- Do not mark Inventory complete until all listed submodules are migrated or explicitly justified.

### 7. Verification gates

For each completed slice:

- Run the targeted architecture test.
- Run TypeScript typecheck.
- Use Playwright smoke checks for the routed workflows:
  - `/purchases/bills` → Add Bill → `/purchases/bills/new` renders a usable create form, no dialog.
  - `/purchases/bills?action=create` redirects to `/purchases/bills/new`.
  - Inventory list Add/Edit/View flows navigate to routes or open approved sheets, not legacy dialogs.
- Confirm existing payment, email, print, delete confirmation, reverse-adjustment, and other allowed dialogs still work and are not accidentally removed.