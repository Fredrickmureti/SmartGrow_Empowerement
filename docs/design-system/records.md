# Record-interaction standard

This document is the enterprise UX standard for **business-record
interactions** across the ERP. It was extracted from the HR/Payroll
redesign and is now the single interaction language every application
(Sales, Purchases, Inventory, HR, Finance, POS, …) must follow.

If you are adding or touching any create / edit / duplicate / convert /
configure / process / wizard / setup / assignment surface, read this
first. Nothing here is optional.

## The taxonomy

Every record-oriented interaction fits into exactly one bucket:

| Bucket | Surface primitive | When to use |
|---|---|---|
| **Object page** | `<RecordShell>` on a dedicated route | Any transactional or master record: Sales Order, Quotation, Invoice, Credit Note, Delivery Note, Purchase Order, GRN, Bill, Transfer, Adjustment, Product, Customer, Supplier, Employee, Contract, Payroll batch. |
| **Guided workspace** | `<WizardShell>` on a route | Multi-step flows: Convert Quote→SO→Invoice, Receive PO, Post Adjustment, Stock Take, Payroll Run, Import. |
| **Side sheet** | `<DetailSheet>` | Quick view or quick-edit of a single record from within a list. Peeks that do not warrant a route. |
| **Dialog** | `Dialog` from `@/components/ui/dialog` | Confirmations, destructive prompts, single-purpose lightweight forms (≤ 6 fields), pickers. |
| **Inline row edit** | Table primitive | Grid-native edits of line items, price list rows, tax rules. |

**A business record never lives inside a bare Dialog.** If a legacy
dialog currently holds a Sales Order, PO, Product, or similar record,
it must be reclassified — object page for edit/detail, side sheet for
peek, dialog only for confirm-style follow-ups.

## Primitives — the only approved surface

Import everything from `@/design-system`. Do not reach into
`./primitives/*` directly, and do not fork parallel implementations.

```ts
import {
  RecordShell,
  RecordHeader,
  DetailSheet,
  WizardShell,
  WizardStepper,
  FooterActionBar,
  SummaryPanel,
  FieldGrid,
  FieldCell,
  FieldGroup,
  Section,
  StatusBadge,
  ActionBar,
} from "@/design-system";
```

### Object page skeleton

```tsx
<RecordShell
  header={
    <RecordHeader
      eyebrow="Sales Invoice"
      title="Acme Corp — March services"
      docNumber="INV-000123"
      status={<StatusBadge tone="warning">Draft</StatusBadge>}
      meta={<><span>Due 2026-03-15</span><span>KES 128,400.00</span></>}
      actions={<ActionBar>{/* primary buttons */}</ActionBar>}
    />
  }
  aside={
    <SummaryPanel>
      <SummaryPanel.Item title="Totals">…</SummaryPanel.Item>
      <SummaryPanel.Item title="Activity">…</SummaryPanel.Item>
    </SummaryPanel>
  }
  footer={
    <FooterActionBar
      leading={<Button variant="ghost">Delete draft</Button>}
      trailing={
        <>
          <Button variant="outline">Save draft</Button>
          <Button>Post</Button>
        </>
      }
    />
  }
>
  <Section title="Customer">
    <FieldGrid columns={3}>
      <FieldCell>{/* Customer picker */}</FieldCell>
      <FieldCell>{/* Branch */}</FieldCell>
      <FieldCell>{/* Currency */}</FieldCell>
    </FieldGrid>
  </Section>

  <Section title="Lines">
    {/* LineItemsGrid */}
  </Section>
</RecordShell>
```

### Side sheet skeleton

```tsx
<DetailSheet
  open={open}
  onOpenChange={setOpen}
  size="lg"
  title="Quick-edit product"
  description="Changes save immediately."
  footer={
    <FooterActionBar
      anchor="sheet"
      trailing={<Button onClick={save}>Save</Button>}
    />
  }
>
  <FieldGrid columns={2}>…</FieldGrid>
</DetailSheet>
```

### Wizard skeleton

```tsx
<WizardShell
  header={<RecordHeader title="Convert to Invoice" eyebrow="Sales Order" />}
  stepper={
    <WizardStepper
      steps={STEPS}
      activeStepId={active}
      completedStepIds={done}
      onStepClick={setActive}
    />
  }
  footer={
    <FooterActionBar
      leading={<Button variant="ghost" onClick={back}>Back</Button>}
      trailing={
        <>
          <Button variant="outline" onClick={saveDraft}>Save draft</Button>
          <Button onClick={next}>{isLast ? "Submit" : "Next"}</Button>
        </>
      }
    />
  }
>
  {/* current step */}
</WizardShell>
```

## Form composition rules

1. **Never single-column on desktop.** Use `FieldGrid columns={2|3|4}`.
   Full-width fields opt in with `<FieldCell span="full">`.
2. **Group logically.** Related fields go in one `FieldGroup` (address,
   tax, dates, identity). Separate concerns go in separate `Section`s.
3. **Actions live in exactly two places** — `RecordHeader.actions`
   (record-level: Send, Print, Duplicate, Delete) and `FooterActionBar`
   (form submission: Save, Post, Cancel). Never scattered mid-form.
4. **Status is a StatusBadge, always.** No bespoke pills.
5. **Tokens, never literals.** No `text-[15px]`, `p-[18px]`,
   `rounded-[7px]`, `bg-white`. Use `--ds-*` and semantic Tailwind
   classes.
6. **Sticky header + sticky footer.** Long forms must not force the
   user to scroll back up to save.

## Routing contract

- Object pages are real routes: `/sales/invoices/:id`,
  `/purchases/orders/:id`, `/inventory/transfers/:id`. Create uses
  `:id = "new"`.
- Peek sheets open via a search param on the list route:
  `/sales/invoices?peek=<id>`. Browser back closes the sheet.
- Wizards live at `/…/new?step=n` or `/…/:id/convert`.

## What NOT to do

- ❌ Wrap a Sales Order form in `<Dialog>` because it has always been a
  dialog.
- ❌ Author a bespoke sticky footer with `fixed bottom-0` inline. Use
  `FooterActionBar`.
- ❌ Duplicate `<Card><CardHeader><CardTitle>` markup in place of
  `<Section>`.
- ❌ Author a per-module `SalesFormCard`, `PurchasesFormCard`,
  `InventoryFormCard`. There is one form container — `Section` +
  `FieldGrid`.
- ❌ Hand-roll a stepper. Use `WizardStepper`.
- ❌ Ship a create/edit surface without responsive collapse verified at
  1280 / 1024 / 768 / 375 px.

## Migration order

1. **Phase 0 (this doc)** — primitives + standard published.
2. **Sales** — quotations, orders, invoices, credit notes, delivery
   notes, returns, recurring invoices, customers, price lists, sales
   configuration.
3. **Purchases** — RFQs, POs, GRNs, bills, debit notes, returns,
   suppliers, landed costs, purchases configuration.
4. **Inventory** — products, variants, warehouses, transfers,
   adjustments, stock takes, reorder rules, UoMs, lot/serial records,
   inventory configuration.

Each application is completed end-to-end before the next begins. No
partial modernization.