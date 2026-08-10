# Purchases & Accounts Payable — Bills Domain Audit

Evidence-backed. Every claim below traces to a file, migration or view read during this investigation. External benchmarks (SAP S/4HANA MM-IV, Oracle Fusion AP, D365 SCM, NetSuite, Odoo) are used only as reasoning frames and are labelled as such.

## 1. What a Bill is

A **Bill is the recognition of a supplier's claim on the business** — the document that converts a commercial promise into a legally owed, dated, settleable liability. It is created by one business event only: *a supplier invoice (or an equivalent obligation notice) has been received and accepted as owed*.

A Bill is therefore **not**:
- an Expense (that is a *spend* record, often already paid, see §8),
- a Purchase Order (commercial intent, no liability),
- a Goods Receipt (physical custody transfer, no liability — it creates an *accrual*),
- a Payment (settlement of an existing liability).

Bill = liability recognition + AP timing (due date) + a tax point. Nothing else.

## 2. Bill vs Expense in this codebase — they are correctly separate, with one deliberate bridge

`expenses` (`20260108095844…sql:271-289`) is a direct cash/card/petty-cash spend with `payment_method`, `payment_account_id`, `is_billable`; it posts through `post_expense_gl` only (`src/lib/finance/expenseSettlement.ts:1-38`, ADR 0123 monopoly). Later columns `employee_id`, `reimburse_via_payroll`, `reimbursed_payslip_id` (`20260606220757…sql:96-101`) give it a second identity: an **employee payable settled through payroll**, not vendor AP.

The bridge: when an expense is coded to the AP account, `createLinkedBill()` (`src/hooks/useExpensesPaginated.ts:160-249`) spawns a real `bills` row with `source_expense_id` (`20260309121150…sql:3`). Verdict: architecturally sound. Expense = spend/claim capture; Bill = vendor liability; the bridge is explicit and one-directional.

## 3. Actual Procure-to-Pay lifecycle in this system

```text
Supplier master (suppliers, supplier_qualifications, approved_supplier_list)
   -> Purchase Requisition (draft/submitted/approved, self-approval blocked)
   -> RFQ (award_rfq_atomic -> convert_rfq_to_po_atomic)
   -> Purchase Order (draft/submitted/approved/acknowledged/revised/closed)
   -> ASN / inbound_shipments (draft..arrived..received)
   -> Dock appointment (GiST no-overlap)
   -> Goods Receipt (draft -> completed)
        |-- wms_apply_gr_stock  -> stock_movements 'receipt', poi.quantity_received
        \-- finance_post_gr_journal -> Dr Inventory / Cr GRNI      [accrual, not a Bill]
   -> Bill (draft -> received)  [convert_po_to_bill_atomic  OR  manual]
        \-- confirm_bill_atomic -> Dr Inventory|GRNI|Expense + Dr Input tax / Cr AP
   -> 3-way match (match_bill_to_grn | match_bill_atomic)  [manual, after the fact]
   -> AP open item (finance_ap_open_items)
   -> Payment (record_multi_bill_payment / advances / credit notes)
   -> GL settlement + FX + WHT
   -> Vendor ledger, statements, Aged Payables
```

The hypothesised lifecycle in the brief is essentially correct and **is implemented**. Two structural deviations matter: matching happens *after* liability recognition and is manual, and inventory/liability are correctly decoupled.

## 4. Domain ownership map

| Entity | Owner (writer) | Consumers | Source of truth |
| --- | --- | --- | --- |
| Supplier | Purchasing (`suppliers`, `contacts`) | Bills, payments, statements | `contacts` + qualification tables |
| PO / requisition / RFQ | Purchasing RPCs | Bills, GRN, matching | `purchase_orders(_items)` |
| Physical receipt | Warehouse (`wms_apply_gr_stock`) | Inventory, Finance accrual, matching | `stock_movements` |
| Stock quantity/valuation | Inventory (`stock_quants`, `cost_layers`) | Reporting | Inventory domain |
| Vendor liability | AP (`confirm_bill_atomic`) | GL, aging, payments | `bills` + `ap_subledger_entries` |
| Settlement | AP (`record_multi_bill_payment`) | GL, bank rec | `bill_payment_allocations` |
| Accounting truth | Finance (`post_journal_entry_atomic`) | All reporting | `journal_entries` |
| Open items / aging | Finance views | Bills page, Aged Payables | `finance_ap_open_items` |

Boundaries are enforced, not merely documented: a commit-time DB invariant (`20260718022614…sql:346-361`) plus `src/test/architecture/procurement.test.ts` forbid any Procurement RPC from touching `stock_movements`, `stock_quants`, `cost_layers`, `journal_entries` (allowlist: landed-cost functions only).

## 5-7. Bill, accounting and inventory lifecycles

`bill_status` enum (`20260109222649…sql:7`): `draft, received, partial, paid, overdue, void`.

Implemented transitions: `draft -> received` (`confirm_bill_atomic`); `received/partial -> partial|paid` (payment RPCs, rule `amount_paid >= total ? paid : partial`); any non-void `-> void` (`void_bill_atomic`, `20260807133834…sql:369-461`, reverses the JE). **No writer ever sets `overdue`** — it is an enum value the list page filters on but nothing populates; a bill past due stays `received`.

Posting (`confirm_bill_atomic`, `20260424151659…sql:303-537`, patched `20260808182518…sql:110-140`) resolves accounts, never hardcodes: credit = vendor `default_payable_account_id` -> role `accounts_payable`; debit per line = line `account_id` -> GRNI (if line links a received PO item and product tracks inventory) -> product inventory override -> product purchase account -> vendor default expense -> role `operating_expenses`/`cogs`; plus `input_tax` (raises if tax > 0 and unset). All validated by `assert_account_in_business`.

Inventory changes **only** on GR completion. No bill RPC writes stock. GRNI is the correct clearing bridge, and the bill consumes it.

## 8. Findings — what is actually wrong

**🔴 C1 — Duplicate supplier invoice liability is unprevented.** `vendor_invoice_number` is free text; the only unique index is `uq_bills_business_number (business_id, bill_number)` (`20260419231218…sql:71`). No supplier-scoped uniqueness, no soft duplicate check anywhere. A vendor sending `INV-1001` twice creates two payables.

**🔴 C2 — Matching is optional, manual and non-blocking.** `match_bill_atomic` (`20260718111607…sql:131-320`) computes variances against `poi.quantity_received` (true 3-way) and records `bill_match_exceptions` as `pending_review`, but nothing gates `confirm_bill_atomic` on match state, and `match_bill_atomic` has **no caller in `src/`** — only the older line-level `match_bill_to_grn` is wired, behind a manual "Match receipts" button (`useBillActions.tsx:57-79`). Two matchers, one dead, zero enforcement.

**🔴 C3 — `convert_po_to_bill_atomic` bills the ordered quantity.** It copies full `purchase_order_items.quantity` and increments `quantity_billed` by the ordered amount (`20260423212723…sql:199-208`), ignoring `quantity_received`. Partial receipt then over-bills by construction, and `v_po_line_billed_progress.billed_drift` (a check view with no enforcing constraint) is where it surfaces.

**❌ C4 — Bills list bypasses the canonical AP projection.** `finance_ap_open_items` + `get_ap_summary` are declared the only payable source (`src/services/finance/openItems.ts:1-10`, guarded by `aging-single-source.test.ts`), yet `src/pages/Bills.tsx:546-550` computes Outstanding/Overdue with a client `reduce` over `total - amount_paid`, filtered on `bill_date`, and `useBills.ts:146-158` fetches every bill with no `.range()`. Overdue reads a status nothing writes (C1 of §5-7), so the card is structurally always 0 or wrong. Balance is recomputed client-side in four places including `billView.tsx:53`.

**❌ C5 — No approval state.** `confirm` doubles as submit + approve + post (`useBillActions.tsx:107-230`). There is no `submitted`/`approved` state, so SoD on liability recognition exists for requisitions and matching but not for the Bill itself.

**⚠ C6 — Purchase tax is a flat rate table.** `BillCreatePage.tsx:205` picks from `tax_rates`; no jurisdiction/localization purchase-tax resolver was found. WHT is a single `contacts.withholding_tax_rate` (`20260222133032…sql:67-72`), correctly reversed with the settlement JE.

**⚠ C7 — Project is a tag, not a dimension.** `bills.project_id` / `bill_items.project_id` bypass `analytic_distributions`, which the rest of GL uses. Legitimate need, wrong mechanism.

**⚠ C8 — Currency is not really chosen.** `createBill` forces `currency = baseCurrency` (`useBills.ts:271`); the FX machinery below it (`currency_rate`, `company_currency_total`, realised FX at payment per `20260423150814…sql:20-31`) is sound but unreachable from the UI.

**⚠ C9 — Bill lines cannot express non-product economics.** Freight, deposits/prepayments and fixed assets have no line kind; they land as untyped lines whose account is guessed by the fallback chain.

**✅ Correct and to be consumed, not rebuilt:** allocation-first AP payments (ADR 0028/0126), vendor credit subledger (ADR 0132), posting monopoly (ADR 0123), GR reversal (ADR 0128), `finance_ap_open_items`, GRNI accrual, receipt-only stock, branch scoping ratchets.

## 9. Bill form field verdicts

| Field | Verdict |
| --- | --- |
| Supplier | ✅ canonical, loads vendor payable/expense/term defaults |
| Vendor invoice # | 🔴 free text, no supplier-scoped uniqueness or duplicate warning |
| Bill date | ⚠ conflated with posting date and tax point; single date drives all |
| Payment terms | ✅ resolved supplier -> org -> due-on-receipt |
| Due date | ✅ derived, override allowed — but override is unreasoned and unaudited |
| Project | ⚠ see C7 |
| Product / Qty / Price | ⚠ product-shaped only; no PO/receipt line binding in the form |
| Tax | ⚠ flat rate, see C6 |
| GL account (line) | ✅ `LineAccountCell`, ratcheted by `bill-line-account-visibility.test.ts` |
| Discount / Total | ✅ derived, recomputed server-side |
| Notes | ✅ |
| **Missing** | PO/GRN line picker, line kind (item/service/freight/asset/prepayment), currency + rate, duplicate-invoice check, match panel, approval, supplier-invoice date vs posting date |

## 10. Verdict table

| Area | Verdict | Canonical owner | Risk |
| --- | --- | --- | --- |
| Bill definition | ✅ | AP | low |
| Supplier invoice reference | 🔴 | AP | duplicate liability, double payment |
| PO -> Bill | ❌ bills ordered qty | Purchasing | over-billing |
| GRN -> Bill | ⚠ via `quantity_received` only in matcher | Warehouse | accrual left in GRNI |
| Inventory relationship | ✅ decoupled, ratcheted | Inventory | low |
| Expense relationship | ✅ separate + explicit bridge | Expenses / AP | low |
| AP | ✅ views + subledger | Finance | low |
| GL | ✅ single poster, resolved accounts | Finance | low |
| Payments | ✅ allocation-first, advances, refunds, void | AP | low |
| Credit notes | ✅ ADR 0132 subledger | AP | low |
| Tax | ⚠ flat rates | Finance/Localization | compliance |
| Multi-currency | ⚠ engine sound, UI forces base | Finance | medium |
| Matching | 🔴 manual, dead matcher, non-blocking | Purchasing/AP | fraud + leakage |
| Bill lifecycle | ❌ no approval, `overdue` never set | AP | control gap |
| Bills overview | ❌ CRUD + client reduce, unpaginated | Finance views | wrong numbers at scale |
| Supplier master | ✅ | Purchasing | low |
| Project allocation | ⚠ tag not dimension | Finance | reporting |
| Product/service lines | ⚠ no line kinds | AP | mis-posting |

## 11. Recommended remediation sequence (no code written yet)

1. **Duplicate invoice control** — partial unique index on `(organization_id, vendor_id, upper(vendor_invoice_number))`, plus a pre-submit soft check surfacing the existing bill; policy flag for businesses that permit duplicates.
2. **Bill lifecycle + approval** — add `submitted`/`approved`, move posting behind approval, reuse the existing `approval_requests` engine rather than inventing one; retire or compute `overdue`.
3. **Match enforcement** — wire `match_bill_atomic` as the single matcher, run it on confirm, and gate approval (not draft editing) on `exception_state`; retire `match_bill_to_grn`.
4. **Receipt-aware conversion** — `convert_po_to_bill_atomic` bills `quantity_received - quantity_billed`; promote `billed_drift = 0` to a constraint or invariant test.
5. **Bills page onto canonical AP** — replace client reduce with `get_ap_summary`/`finance_ap_open_items`, paginate `useBills`, add a ratchet test; surface awaiting-approval, match exceptions, unmatched-GRN and duplicate suspicion.
6. **Line kinds + analytic distributions + currency exposure** — typed bill lines, project via `analytic_distributions`, expose currency/rate the engine already supports.
7. **Purchase tax resolver** — one localization-driven purchase-tax rule surface shared by bills, credit notes and returns.

Steps 1-5 are the control-integrity core; 6-7 are correctness-of-model work that can follow.
