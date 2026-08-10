# Purchases & Accounts Payable — Verification Verdict, then Step 3 → 7

Source audit: `.lovable/plan/purchases-accounts-payable-bills-domain-audit-2026-08-10.md`
(findings C1–C9, remediation steps 1–7). This file is the live status.

## Phase 1 — Independent verification of the previous engineer's claims

Every claim was checked directly against the live database and the source tree.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Step 1 — duplicate supplier-invoice control | **Confirmed** | `find_duplicate_vendor_invoice(_org_id,_vendor_id,_vendor_invoice_number,_exclude_bill_id)` exists; trigger `trg_bills_unique_vendor_invoice_number` on `bills`; policy column `businesses.allow_duplicate_vendor_invoice_numbers`; `BillCreatePage` calls the soft check |
| Step 1 leftover — same warning on Bill edit | **Still open** | `findDuplicateVendorInvoice` has exactly one caller (`BillCreatePage`); `BillEditPage` never calls it |
| Step 2 — lifecycle + approval gate | **Confirmed** | `bill_status` now carries `submitted`, `approved`; `submit_bill_atomic`, `approve_bill_atomic`, `reject_bill_atomic` all exist; trigger `trg_bills_approval_gate` present; `confirm_bill_atomic` really does accept `approved`; policy columns `require_bill_approval`, `block_bill_approval_on_match_exception` |
| Step 2 leftover — `overdue` status still stored | **Still open** | `trg_bill_overdue_check` still writes a stored status the audit said should be computed |
| Step 3 — match enforcement | **Overstated.** Only the approval gate landed | `match_bill_atomic` still has **zero callers in `src/`**; the wired client action is still the legacy `match_bill_to_grn` (`useBillActions.tsx:64`), behind a manual button; no match state is surfaced anywhere in the UI; no ratchet test |
| Step 4 — receipt-aware PO→Bill | **Confirmed** | `convert_po_to_bill_atomic` references `quantity_received`. Invariant test still missing |
| Step 5 — Bills page on canonical AP | **Confirmed for money KPIs** | `Bills.tsx` imports and uses `useApSummary`; remaining `reduce`/`total - amount_paid` occurrences are per-row display and filtered document counts, which is correct |
| Step 5 leftovers — pagination + ratchet | **Still open** | `useBills` queries `bills` with no `.range()`; no test pins the KPIs to `get_ap_summary` |
| Steps 6–7 | **Correctly reported as not started** | no line-kind column, no `analytic_distributions` use from bills, `createBill` still forces base currency, tax still flat `tax_rates` |

**Net:** Steps 1, 2, 4, 5 are genuine (with named leftovers). Step 3 was reported
as "partial" but is closer to *not started* — the enforcement half exists, the
matcher consolidation does not. Two matchers still exist, the correct one is
dead code, and a test (`stock-event-fabric-and-landed-cost.test.ts`) actively
pins the legacy one in place, so retiring it requires updating that ratchet.

## Phase 2 — Plan corrections and additions

Added, based on the above:

- **3d (new)** — `stock-event-fabric-and-landed-cost.test.ts` asserts the Bill
  record page wires `match_bill_to_grn`. Retiring the legacy matcher must
  repoint that assertion, not delete the guarantee.
- **3e (new)** — landed-cost allocation currently rides on the legacy matcher.
  Confirm `match_bill_atomic`'s `_landed_cost_bill_id` path covers it before
  removal, otherwise landed cost silently stops working.
- **2b (new)** — retire stored `overdue`: derive it, keep the enum value for
  back-compat, drop `trg_bill_overdue_check`'s write.

## Phase 3 — Execution order

### Step 3 — one matcher, automatically run, visible (active)
1. Extend `match_bill_atomic` if needed so it fully supersedes
   `match_bill_to_grn` (line linkage into `bill_grn_matches`, landed cost).
2. Call it automatically from `submit_bill_atomic` (and on GRN linkage change),
   so match state exists before anyone approves.
3. Repoint the client: `useBillActions` "Match receipts" → `match_bill_atomic`;
   revoke/retire `match_bill_to_grn`.
4. Surface match state — matched / exception / no-receipt — as a Bills list
   column and a record-page panel with an exception review + resolve action.
5. Ratchet test: nothing outside the matcher writes `bill_match_results`, and
   no client calls `match_bill_to_grn`. Update the stock-event-fabric test.

### Step 4/5 leftovers
6. Invariant test (or DB constraint) for `billed_drift = 0`.
7. Server-side pagination for `useBills`.
8. Ratchet pinning Bills money KPIs to `get_ap_summary`.
9. Duplicate-invoice warning on `BillEditPage` (passing `_exclude_bill_id`).
10. Computed `overdue`.

### Step 6 — model correctness
11. Typed bill line kinds (item / service / freight / asset / prepayment /
    charge) driving account determination instead of the guess-chain.
12. Project costing moved onto `analytic_distributions`; `project_id` becomes a
    projection, not the store.
13. Expose currency + rate in the Bill UI (the FX engine already supports it).

### Step 7 — purchase tax
14. One localization-driven purchase-tax resolver shared by bills, vendor credit
    notes and purchase returns.

## Invariants to preserve
- Posting monopoly (ADR 0123): no new journal writers.
- Matching and approval never touch inventory; stock moves only on GRN
  completion via `wms_apply_gr_stock`.
- AP money figures come from `finance_ap_open_items` / `get_ap_summary` only.
