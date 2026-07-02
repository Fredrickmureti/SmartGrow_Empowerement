# ADR 0030: AP Subledger Mirror & Control-Account Tie-Out

## Status
Accepted — 2026-06-02

## Context
ADR-0029 anchored Accounts Receivable to a single GL-derived engine
(`ar_subledger_entries`), with `customer_ledger_entries` re-implemented as a
thin display projection. The Accounts Payable side still re-aggregated source
documents (bills, bill_payments, vendor_credit_notes) inside
`vendor_ledger_entries`, which meant:

1. Vendor balances could drift from the AP control account in the GL whenever
   a manual journal, void, or partial allocation touched the books without
   going through one of those three source tables.
2. There was no automated way to *prove* that the subledger and the GL agreed.

## Decision

### 1. Mirror the AR engine for AP
- New helper `public.is_ap_control_account(uuid)` identifies AP control
  accounts via `accounts.system_role = 'accounts_payable'`.
- New view `public.ap_subledger_entries` is the canonical AP subledger: a
  filtered projection of posted `journal_entry_lines` whose `account_id` is
  an AP control account. Shape mirrors `ar_subledger_entries` exactly.
- `public.vendor_ledger_entries` is rewritten as a thin display layer over
  `ap_subledger_entries`, joining back to `bills`, `bill_payments`, and
  `vendor_credit_notes` solely for `doc_ref` labels.

### 2. Extend AR subledger with `account_id`
`ar_subledger_entries` now carries `account_id`. This is required so the
tie-out view can reconcile per control account (orgs may legitimately have
more than one AR/AP control account in the future).

### 3. Control-account tie-out
New view `public.control_account_tieout` returns, per
`(organization_id, account_id)`:
- `gl_balance` — sum of `debit - credit` on the control account in posted GL
  lines.
- `subledger_balance` — sum of `debit - credit` in the matching AR/AP
  subledger view.
- `drift` — the difference; **must be zero**.

Because both sides are now derived from the same `journal_entry_lines`,
`drift` is mathematically zero by construction. The tie-out exists as a
guardrail: any future code path that mutates the GL without flowing through
the subledger views (or vice versa) will surface here immediately.

## Consequences

- `vendor_ledger_entries` and `customer_ledger_entries` are now both
  GL-anchored. Sales-side and Finance-side reports reconcile by construction.
- Finance can monitor integrity via `select * from control_account_tieout
  where drift <> 0` (expected to always be empty).
- Any future requirement to record AR/AP activity outside the GL (e.g. a
  non-posting workflow) MUST first add a corresponding posted journal entry,
  otherwise the subledger will not see it.

## Out of scope (future work)
- Invariant trigger enforcing that every GL line on an AR/AP control account
  carries a `contact_id`.
- A scheduled job/email alert that fires when `control_account_tieout`
  returns a non-empty result.
- A `Trial Balance vs Subledger` admin screen rendering the tie-out view.
