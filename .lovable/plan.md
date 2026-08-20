# Receivables & Partners Reporting — Investigation Findings + Phase 1

Scope: Aged Receivables, Aged Payables, Partner Ledger, Sales Reports.
Investigation only so far. No code changed.

## Verdict on the supplied taxonomy

RECOMMENDATION — the four names are mostly right, but one is wrong and two are
incomplete:

- Aged Receivables / Aged Payables: correct as **one** report family with a
  side dimension (AR/AP). They already share one page and one RPC. Do not split.
- Partner Ledger: correct as a family, but it must be a true ledger
  (opening → movements → closing, drillable to the journal entry). Today it is
  close, but the ledger maths runs in the browser.
- "Sales Reports": **not a correct accounting report**. What exists is an
  invoice-activity dashboard. Professional practice (NetSuite "Sales by X",
  Odoo Sales Analysis, D365 Sales Statistics) treats sales as one dimensional
  model — measures (gross, discounts, returns/credit notes, net, tax, cost,
  margin) across dimensions (customer, product, category, branch, business,
  salesperson, period, currency). It should be one dimensional report family,
  not four pages, and its net-sales figure must reconcile to the revenue
  accounts in the GL.
- Missing from the family (RESEARCH FINDING, standard in NetSuite/Odoo/D365):
  a **Customer/Vendor Statement of Account** run (exists separately — verify,
  do not rebuild), and **A/R–A/P to control-account reconciliation** (exists as
  `ControlAccountReconciliation`). No new report pages are proposed yet.

## Verified facts

VERIFIED FACT — Aged Receivables/Payables are one page (`src/pages/reports/AgingReport.tsx`)
driven by RPC `get_ar_ap_aging_from_ledger` via `useAgingReport.ts:111`. Buckets and
days-overdue come from SQL; JS only regroups. Screen and export share one
`columns`/`rows` declaration (`AgingReport.tsx:204-215`). AR side reads
`finance_ar_open_items`; AP side reads `finance_ap_open_items_as_of(...)`, which
takes a real as-of date and FIFO-applies settlements. AR uses
`base_residual_amount`.

VERIFIED FACT — asymmetry between the two sides: AP is answered *as of* a date by
a parameterised function; the AR branch of `get_ar_ap_aging_from_ledger` reads
the plain `finance_ar_open_items` view, which can only describe today. So an
"as of" aging date is honoured for payables and is not a true historical
restatement for receivables.

VERIFIED FACT — Partner Ledger (`src/pages/reports/PartnerLedger.tsx:119-245`)
does not call an RPC. It pages every prior-period row of
`customer_ledger_entries` / `vendor_ledger_entries` into the browser (1000 rows
per request, unbounded loop), then computes opening balance, running balance and
closing balance in JS. It selects `doc_type/doc_id/doc_ref` but not
`journal_entry_id`, so there is no drill-down to the originating journal entry,
and `description` is just the raw `doc_type` string.

VERIFIED FACT — those two views expose `debit`, `credit`, `currency` but no
base-currency column, and have no as-of parameter.

VERIFIED FACT — Sales Reports (`src/pages/reports/SalesReports.tsx:61-102`) reads
`useInvoices()` and aggregates in the browser. It filters on a status list
`["sent","viewed","partial","paid","overdue"]`, sums `inv.total` with no
currency conversion, and never touches credit notes, returns, discounts, tax,
product, category, branch or salesperson. Its export payload is hand-built
(`:152-196`) rather than derived from the on-screen columns/rows like the other
reports. It cannot reconcile to revenue in the GL.

VERIFIED FACT (security, critical) — `get_control_account_reconciliation` is
`SECURITY DEFINER`, `EXECUTE` granted to `authenticated`, and its body contains
**no membership check**; it uses the caller-supplied `_org_id` as a bare equality
filter. Its siblings (`get_ar_ap_aging_from_ledger`, `get_ap_summary`,
`finance_ap_open_items_as_of`) all begin with
`IF NOT public.finance_can_read_org(_org_id) THEN RAISE EXCEPTION`. Any signed-in
user of any tenant can therefore read another organisation's AR/AP control
balance, sub-ledger total and drift by passing that org's UUID.

VERIFIED FACT (security, secondary) — `get_ar_summary` is *not* SECURITY DEFINER,
has no membership check, and is granted to `anon` as well as `authenticated`. It
reads `finance_ar_open_items`, which is an owner-run view (`reloptions` is null,
i.e. no `security_invoker`) with no SELECT grant to `anon`/`authenticated`. So it
is not currently a leak, but it is the one AR entry point with no explicit gate,
and its grant to `anon` is unjustified. `get_ap_summary` is correctly gated.

VERIFIED FACT — `finance_open_items_tieout` is also owner-run (no
`security_invoker`); `customer_ledger_entries`, `vendor_ledger_entries`,
`finance_ar_customer_credit` and `finance_ar_net_position` are invoker views,
and `finance_ar_net_position` additionally carries an explicit
`is_org_member(auth.uid(), organization_id)` predicate.

INFERENCE — Partner Ledger's org/business scoping currently rests entirely on RLS
of `ar_subledger_entries`/`ap_subledger_entries` via invoker views plus client-side
`.eq()` filters. RLS enforcement on those base tables has not yet been read; it
must be confirmed before the ledger is called safe.

## Confirmed defects (ranked)

1. Cross-organisation exposure via `get_control_account_reconciliation`. Critical.
2. Sales Reports is not an accounting report: browser aggregation, no credit
   notes/returns/discounts/tax, no currency normalisation, no GL reconciliation,
   invented status vocabulary. High.
3. Partner Ledger computes authoritative balances in the frontend and cannot
   drill to the journal entry; unbounded client paging is a performance cliff. High.
4. AR aging cannot answer a historical as-of date the way AP can. Medium-high.
5. `get_ar_summary` ungated and granted to `anon`. Medium.

## Phase 1 — Security hardening (proposed first implementation step)

Smallest, highest-risk-reduction, no report behaviour change.

1. Migration: add `IF NOT public.finance_can_read_org(_org_id) THEN RAISE
   EXCEPTION ... ERRCODE '42501'` to `get_control_account_reconciliation`, and
   `REVOKE ALL ... FROM PUBLIC, anon; GRANT EXECUTE TO authenticated, service_role`.
2. Migration: same gate for `get_ar_summary` (converted to the gated pattern its
   AP twin already uses) and revoke `anon` execute.
3. Read the RLS policies on `ar_subledger_entries` / `ap_subledger_entries` and
   record the verdict here before Partner Ledger work begins.
4. Tests: a SQL test asserting every AR/AP reporting RPC raises 42501 for a
   non-member org id, plus an architecture test that any new
   `SECURITY DEFINER` function taking `_org_id` calls `finance_can_read_org`.

Exit criteria: cross-org call of every report RPC in this family raises 42501;
existing Aging / Control Account screens unchanged for a legitimate user.

## Later phases (not started, order is a recommendation)

- Phase 2 — AR as-of parity: `finance_ar_open_items_as_of(...)` mirroring the AP
  function, wired into `get_ar_ap_aging_from_ledger`, so aging is genuinely
  historical on both sides. Tie-out test against the control account per as-of date.
- Phase 3 — Partner Ledger to SQL: one `get_partner_ledger(_org,_business,_branch,
  _side,_contact,_from,_to)` returning opening balance, movements with
  `journal_entry_id` and a document label, running balance and closing balance;
  page becomes a thin renderer; closing balance asserted equal to the control
  account.
- Phase 4 — Sales analysis rebuilt as a SQL dimensional report (gross, discount,
  returns/credit notes, net, tax, cost, margin × customer/product/category/
  branch/salesperson/period), reconciled to revenue accounts, replacing the
  client-side aggregation.
- Phase 5 — drill-down and export parity for the rebuilt reports.
- Phase 6 — scenario test matrix: partial payment, unapplied receipt, advance,
  credit note, refund, write-off, void/reversal, FX, closed period, multi-branch,
  multi-business, cross-org denial.

## Status
Investigation complete for the four reports. Awaiting approval of Phase 1.
