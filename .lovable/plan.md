# Purchases & Accounts Payable — Bills Domain Convergence (authoritative status)

Source audit: `.lovable/plan/purchases-accounts-payable-bills-domain-audit-2026-08-10.md`
(findings C1–C5, remediation sequence steps 1–7). This file is the live status of
that roadmap. Update it after every implementation.

## Roadmap status

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Duplicate invoice control | **Done & verified** |
| 2 | Bill lifecycle + approval gate | **Done & verified** |
| 3 | Match enforcement (single matcher, approval gated on exceptions) | **Partial — active phase** |
| 4 | Receipt-aware PO→Bill conversion | **Done, needs invariant test** |
| 5 | Bills page onto canonical AP | **Done in UI, ratchet test + pagination pending** |
| 6 | Line kinds, analytic distributions, currency exposure | Not started |
| 7 | Purchase tax resolver | Not started |

---

## Step 1 — Duplicate invoice control (COMPLETE)

Deployed and verified in DB:

- `businesses.allow_duplicate_vendor_invoice` policy column.
- Trigger `trg_bills_unique_vendor_invoice_number` — rejects a second bill with
  the same `(organization_id, vendor_id, upper(vendor_invoice_number))` unless the
  company policy allows duplicates. Void bills are excluded.
- RPC `find_duplicate_vendor_invoice(_org_id, _vendor_id, _vendor_invoice_number,
  _exclude_bill_id)` — pre-submit soft check.

Frontend:

- `useBills.findDuplicateVendorInvoice()` wraps the RPC (non-fatal on failure —
  the trigger remains the hard guarantee).
- `BillCreatePage` runs a debounced lookup on (supplier, vendor invoice #) and
  renders an inline destructive warning naming the clashing bill(s).

Pending: same warning on `BillEditPage` (pass `_exclude_bill_id`).

## Step 2 — Bill lifecycle + approval gate (COMPLETE)

`bill_status` enum now: `draft, submitted, approved, received, partial, paid,
overdue, void`. `submitted`/`approved` are pre-GL review states — no journal
entry exists and they are excluded from AP liability figures.

Deployed:

- `submit_bill_atomic`, `approve_bill_atomic` (segregation of duties: submitter
  cannot approve; blocks on open match exceptions when policy requires),
  `reject_bill_atomic` (returns to draft with a reason).
- Trigger `trg_bills_approval_gate` / `enforce_bill_approval_gate` — blocks
  posting an unapproved bill when `businesses.require_bill_approval` is on.
- `confirm_bill_atomic` patched to accept `draft` **or** `approved` (previously
  hardcoded `draft`, which would have deadlocked approved bills).
- `get_ap_summary` excludes `draft`/`submitted`/`approved` from liability.

Frontend:

- `useBills` exposes `requireBillApproval`, `submitBillForApproval`,
  `approveBill`, `rejectBill`; `createBill` auto-submits when policy requires.
- `Bills.tsx` pipeline is Draft → Submitted → Approved → Posted → Partial → Paid;
  row menu offers Submit / Approve / Reject / Post to Ledger by state, and
  Record Payment only for posted states (`received`, `partial`, `overdue`).

Pending: reuse the shared `approval_requests` engine for multi-step/threshold
routing (current gate is single-step), and retire the stored `overdue` status in
favour of a computed one.

## Step 3 — Match enforcement (ACTIVE PHASE, PARTIAL)

Done: `approve_bill_atomic` refuses approval while `bill_match_results` carries a
`pending_review` exception (policy `block_on_match_exception`).

Still to do — this is the next work:

1. Make `match_bill_atomic` the **single** matcher; retire `match_bill_to_grn`
   and any client-side match paths.
2. Run the matcher automatically on submit (and on GRN linkage change), not only
   when a user opens the match screen.
3. Surface match state on the Bills list and record page (matched / exception /
   unmatched-GRN), with an exception review action.
4. Architecture ratchet test: no caller outside the matcher writes
   `bill_match_results`.

## Step 4 — Receipt-aware conversion (COMPLETE, TEST PENDING)

`convert_po_to_bill_atomic` now bills `quantity_received - quantity_billed`
(3-way basis) and supports partial billing. Pending: promote `billed_drift = 0`
to a DB invariant or invariant test.

## Step 5 — Bills page onto canonical AP (UI COMPLETE)

- `src/hooks/useApSummary.ts` reads `get_ap_summary` (canonical AP projection,
  net of allocations and vendor credits, aging buckets).
- `Bills.tsx` Outstanding/Overdue KPIs now come from that hook — the client-side
  `total - amount_paid` reduces are gone. Document counts remain client-side
  because they describe the filtered list.
- Second KPI card switches to "In approval" when the approval policy is on.

Pending: server-side pagination for `useBills` (currently fetches the table) and
a ratchet test pinning Bills money KPIs to the canonical AP source.

## Steps 6–7 — not started

Typed bill line kinds, project costing via `analytic_distributions`, exposed
currency/rate, and a shared localization-driven purchase tax resolver.

---

## Instructions for the next agent

1. **Verify before building.** Confirm, don't assume:
   - DB objects exist and behave: `submit_bill_atomic`, `approve_bill_atomic`,
     `reject_bill_atomic`, `find_duplicate_vendor_invoice`,
     `enforce_bill_approval_gate`, `trg_bills_unique_vendor_invoice_number`,
     `convert_po_to_bill_atomic`, `get_ap_summary`.
   - `confirm_bill_atomic` really accepts `approved` (regression risk: any later
     redefinition may reintroduce the `status <> 'draft'` guard).
   - A bill created with `require_bill_approval` on cannot be posted before
     approval, and the submitter cannot self-approve.
   - `Bills.tsx` shows no client-side money reduces; `useApSummary` drives them.
2. **Then resume at Step 3 (match enforcement)** in the order listed above.
   Do not start Steps 6–7 while Step 3 is open.
3. Close Step 3 completely — DB matcher, automatic trigger points, UI surfacing,
   ratchet test — before moving to the Step 4/5 leftovers (billed-drift invariant,
   `useBills` pagination, AP ratchet test).
4. Keep the rule the audit established: matching and approval never touch
   inventory; stock moves only on GRN completion via `wms_apply_gr_stock`.
