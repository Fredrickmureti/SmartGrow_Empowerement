# Proforma Invoice — Domain Audit Verdict (2026-08-08)

## Verdict

The Proforma domain is **semantically correct and safe at its dangerous boundaries**; it needed
convergence, not a rewrite. Defects found were confined to numbering safety, item-level RLS,
lifecycle governance and provenance. All have been closed.

## Business definition

A Proforma Invoice is a **binding-looking but non-accounting commercial declaration of what an
invoice will say** — used for advance-payment requests, customs/import documentation and buyer-side
purchase approval. It creates no receivable, no revenue, no tax liability and no stock commitment.
It becomes economically real only on conversion into an Invoice.

| Document        | Economic meaning                                   |
| --------------- | -------------------------------------------------- |
| Estimate        | Negotiable offer, pipeline only                     |
| Sales Order     | Operational commitment, reserves stock              |
| **Proforma**    | **Payment / customs instrument, no commitment**     |
| Invoice         | Accounting event (AR + revenue + tax)               |
| Delivery Note   | Inventory event (COGS)                              |
| Receipt/Payment | Cash                                                |
| Credit Note     | Reversal of an invoice                              |
| Advance/Deposit | Cash before an invoice — `record_advance_payment`   |

Paying a proforma directly is intentionally impossible; customer money before invoicing has a
canonical home in advance payments.

## Confirmed-safe properties (unchanged)

- **Accounting-safe** — no journal entry, AR, revenue, tax-liability or customer-balance write on any
  proforma path. Conversion produces a *draft* invoice; posting happens on invoice confirmation.
- **Inventory-safe** — no stock movement, reservation or warehouse effect.
- **Payment-safe** — settlement UI is invoice-only.
- **Document-architecture compliant** — printing flows through `ensureDocumentRecord` →
  `sales.proforma` snapshot → `document_records`. No second PDF engine.
- **Conversion** — `convert_proforma_to_invoice_atomic` is atomic, idempotent (`converted_invoice_id`
  guard under `FOR UPDATE`), business-scoped and lineage-stamping.

## Defects found and remediation

| # | Defect | Fix |
| - | ------ | --- |
| 1 | `get_next_proforma_number` was org-only, unlocked `MAX()+1`; no unique constraint | Business-scoped numbering under `pg_advisory_xact_lock`, per-business `proforma_prefix`, unique index on (org, business, number) |
| 2 | `proforma_invoice_items` RLS was org-membership `FOR ALL`; header RLS lacked business scope | Per-command policies on both tables using `user_can_access_business` + 4-arg `user_has_module_permission`, plus subscription write gate and explicit grants |
| 3 | Two-step client insert; totals trusted from the client | `create_proforma_atomic(p_header, p_items)` — one transaction, server-recomputed subtotal/discount/tax/total |
| 4 | No state machine, no audit trail, editable after conversion | `set_proforma_status_atomic` + `proforma_status_write_guard`; freeze and delete guards for converted proformas; audit rows on create, status change, convert and delete |
| 5 | Incoherent status vocabulary (`viewed`/`approved` unreachable, no cancellation, unused expiry) | Vocabulary is `draft / sent / accepted / rejected / expired / cancelled / converted`; converter guard aligned; `expire_overdue_proformas()` sweeps overdue sent proformas |
| 6 | Converted proformas were deletable, erasing lineage | `BEFORE DELETE` guard refuses deletion once converted |
| 7 | Row actions had no permission gate | Send / Convert / Cancel / Delete wrapped in `PermissionGate permission="manageSales"`; hook enforces `can("manageSales")` |

## State machine

```text
draft ──► sent ──► accepted ──► (convert) ──► converted [terminal, immutable]
  │         ├──► rejected
  │         └──► expired ──► sent
  └──────────────► cancelled  (from draft/sent/accepted/rejected/expired)
```

`converted` is reachable **only** through `convert_proforma_to_invoice_atomic`.

## Verification

`src/__tests__/architecture.proforma-domain.test.ts` guards: no accounting/inventory references on
proforma paths, atomic create/status/convert RPC usage, no direct client status writes, and the
presence of the hardening migration objects.
