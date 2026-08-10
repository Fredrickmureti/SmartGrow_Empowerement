---
name: Contact identity vocabulary
description: contacts has no contact_type column — customer/supplier selection must use type + customer_rank via services/finance/customerIdentity.ts
type: constraint
---

`public.contacts` columns: `type` (enum **named** `contact_type`, values
customer/supplier/both), `customer_rank`, `supplier_rank`,
`commercial_partner_id` (family rollup parent).

Never reference `contact_type` as a column (PostgREST 42703 crash) or as a JS
property (silently `undefined`, empties pickers with no error).

Use `src/services/finance/customerIdentity.ts`:
- `CUSTOMER_IDENTITY_OR_FILTER` → `.or("type.in.(customer,both),customer_rank.gt.0")`
- `isCustomerContact(contact)` for already-fetched rows

Guard: `src/test/architecture/contact-identity-vocabulary.test.ts`.

**Why:** the enum's type name was mistaken for a column name, crashing the
customer ledger index and silently emptying the timesheet billing dialog.
