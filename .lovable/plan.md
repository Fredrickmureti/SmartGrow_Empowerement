# Smart Grow Empowerment — microfinance platform (plan of record)

One institution. Staff-operated lending. Backend: Supabase `xwxqunklduknceoryrha`.
No SaaS, no multi-tenancy, no client portal, no payroll/HR/sales/inventory/POS/CRM.

## Binding scope contract

**Reuse (tailored to microfinance, never rebuilt):** auth/PIN/invitations, RBAC, app shell +
navigation + design system, document engine (kinds, template AST, PDF renderer), report engine,
and the Finance core — chart of accounts, journals/GL, fiscal periods, banking, bank feeds,
reconciliation, the payment settlement/allocation engine, and accounting events + reversals.

**Retarget, do not delete:** the settlement engine and statement machinery. "Customer statement"
becomes the client loan statement; "vendor/payables" becomes institution payables. The engine
stays; the vocabulary, data source and screens become microfinance.

**Leave out:** every other ERP surface. A bug in a removed ERP surface is not a bug.

**Non-negotiables**
- Financial state is derived server-side. React never owns balances, interest, arrears,
  allocations or journal amounts.
- Append-only business events; postings resolved through configured mappings. `UPDATE loans SET`
  is not a business process. Reversals, never edits.
- One object per migration; GRANTs + RLS in the same migration.
- Every milestone ends with: `tsgo` clean, build OK, affected screens rendered signed-in, this
  file updated. No re-auditing closed milestones.

## Payment reception model (decided — do not re-litigate)

ASA-style group oversight without forcing group loans:
- A **loan** always belongs to one client. A group is an operational/collection structure, not a
  borrower substitute.
- The cashier/officer can receive a payment **per client** or as a **group collection sheet**: one
  meeting, one officer, many client payments captured together, each line settling that client's
  own loan through the same server-side allocation path. A group sheet is a batch wrapper over
  individual `payment_received` events — never a single blended balance.
- Allocation order is policy-driven (configurable per product/institution), not hardcoded.
- Over/short payments produce client credit or arrears via the settlement engine, not ad-hoc UI math.

## Verified state (2026-09-03)

- Shell modules: `dashboard`, `lending`, `finance`, `reports`, `studio`, `platform`. ERP modules gone.
- Lending domain live under `src/apps/lending/*` (clients, groups, products, applications, loans,
  repayments, collections, documents, reports, settings) on the `mf_*` schema.
- `mf_post_event` posts disbursement, settlement-by-successor (top-up/restructure), repayment per
  allocation component, repayment reversal, write-off — via `mf_resolve_account` +
  `post_journal_entry_atomic`, idempotent through `mf_event_postings`. No account ids in app code.
- Finance retained with microfinance vocabulary (loan receivables, institution payables,
  journals, cash & bank, reconciliation, bank feeds, accounting events).
- Documents: `journal_entry` + the four lending kinds only; institution identity injected from
  `businesses`. Client statement reads the server-owned `mf_client_statement` view.
- All `mf_*` tables: RLS on, GRANTs correct, loan-officer scope predicates applied.
  Write paths role-gated server-side; financial-history tables are SELECT-only to clients.
- Inherited customer/vendor statement dataset services verified unreferenced and deleted.

Milestones C1–C11 and C12 steps 1–2 (data security, officer scoping) and the database half of
step 3 (RBAC server enforcement) are **complete and closed**.

## C12 — hardening (current, remaining work only)

1. **Close public registration.** `/signup` is still reachable in the shell. Make account creation
   invite-only: remove the public signup route/links, keep `AcceptInvitation` + admin invite flow.
2. **UI role gating matches the matrix.** Nav and action visibility for Super Admin, Branch Manager,
   Loan Officer, Credit Officer, Cashier, Accountant, Collections Officer, Auditor, Reporting User.
   Cosmetic layer only — the server remains authoritative.
3. **Audit + immutability proof.** Every lending event attributable to a user; reversal-not-edit
   demonstrated; no destructive deletion of financial history.
4. **Fix the hydration mismatch on the auth screens.**
5. **Signed-in render proof:** the four lending documents (agreement, schedule, statement, receipt)
   and each lending report through the retained engines.

Exit gate: no public signup path, role matrix demonstrated, portfolio scoping demonstrated, four
PDFs rendered signed-in, `tsgo` clean, build OK.

## C13 — lending completeness

- `fee_charged` and `penalty_accrued` events + their account mappings in `mf_post_event`.
- Configurable repayment allocation order surfaced in lending settings (policy row, server-read).
- Arrears / days-past-due / PAR derived server-side from schedule-vs-payments, verified on real data.

## C14 — group collections & cash discipline

- Group collection sheet: officer opens a meeting, captures per-client payments, posts as a batch
  of individual `payment_received` events with one shared reference.
- Cashier day: opening float, receipts, banking of collections, close-off reconciled against the
  retained bank/reconciliation engine.
- Collection receipt document per client line; officer/branch collection reports.

## C15 — final hardening

Remove residual unused ERP code only where it is provably unreferenced, then full regression:
lifecycle test (application → approval → disbursement → schedule → repayment → arrears →
closure/write-off), report and document suite, permission matrix, build.

## Known inherited debt (touch only when it blocks a retained surface)

Legacy SQL-migration guards (`je-description-no-uuid`, `pgcrypto-extension-prefix`,
`single-audit-trigger-per-table`, `sql-businesses-currency-column`, `currency-ratchet`), inherited
ERP `SECURITY DEFINER` views (30) and function linter warnings, and content-drift guards
(banking gating ×2, finance-settings permissions, radix overlay, tanstack-router-in-spa,
aged-receivables related-reports). All pre-existing; not in scope.

## Next action

C12 step 1 — make registration invite-only.
