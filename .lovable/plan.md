# Smart Grow Empowerment — convergence plan (reworked 2026-09-01)

Single source of truth. Strategy: reuse only three things from the inherited
AccrualFlow platform — document engine, auth engine (PIN), navigation/UI
foundation. Everything else ERP is unwired now and dropped in one sweep at the
end. Build lending business logic immediately; no exploratory audits.

Backend: already connected to Supabase project `xwxqunklduknceoryrha`.

## Verified state (checked directly today)

| Claim | Verdict |
| --- | --- |
| C1 registry prune, `LENDING_APP` + `/lending/*` scaffold | Confirmed — `src/apps/lending/` exists with nav, routes, placeholders |
| C2 roles + `mf_account_mappings` + accounting-mappings settings screen | Confirmed — table exists in DB, `useMfAccountMappings.ts` present |
| C3 schema (`mf_clients`, `mf_groups`, `mf_group_members`) | Confirmed — all three tables exist |
| C3 client hook | Confirmed — `src/hooks/useMfClients.ts` present |
| C3 groups hook | Done — `src/hooks/useMfGroups.ts` (groups + membership roll) |
| C3 UI (Clients, Groups pages) | Done — real pages wired in `src/apps/lending/routes.tsx` |

**C3 is complete** (typecheck clean). Genuine resume point: **C4 — loan products**.

## C3 — Clients & groups UI — DONE

1. `src/hooks/useMfGroups.ts` — group list/create/update, membership add/exit,
   leader-uniqueness violation surfaced as a friendly error.
2. Clients page: list with search + branch/status filters, register/edit
   dialog (KYC identity, branch, owning loan officer, status).
3. Groups page: list, create, membership management with weekly meeting slot.
4. Both built from `@/design-system` primitives only; replace the two
   placeholders in `src/apps/lending/routes.tsx`.
5. Verify: `tsgo --noEmit` clean, both screens open and load.

Individual liability only — group membership never implies a joint loan.
Clients survive loan closure.

## C4 — Loan products (immutable versions) — IN PROGRESS

Verified done: `mf_loan_products` + `mf_loan_product_versions` exist in the
database with GRANTs, RLS and freeze triggers; `src/hooks/useMfLoanProducts.ts`,
`ProductFormDialog.tsx` and `ProductVersionDialog.tsx` exist.

Verified missing: `ProductsPage.tsx` — the `products` route in
`src/apps/lending/routes.tsx` is still the placeholder.

Remaining: build `ProductsPage.tsx` (product list, status filter, opens the two
existing dialogs), swap the placeholder route, typecheck, open the screen.
Amount band, term, frequency, interest method, fees, penalties, grace,
eligibility, activation live on the frozen version record so live loans never
reprice.


## C5 — Applications → assessment → approval

Draft → Submitted → Under review → Approved/Rejected → Ready for disbursement.
Assessment is an attributable physical visit; approval bounded by authority
limits and cycle eligibility. Requested ≠ approved. Approval ≠ disbursement.

## C6 — Loan, schedule engine, disbursement

Loan snapshots contractual terms. Server-side schedule engine per interest
method and frequency (contractual, not a ledger). Disbursement is an idempotent
guarded event posting through the C2 mappings into the existing journal/GL.

## C7 — Repayments, allocation, arrears, collections

Batch-per-meeting entry with per-member receipts; partial, over and reversal
handling. Allocation order is configuration. Arrears, DPD and PAR derived
server-side. Collections activity, visits, promises — scoped to officer
portfolios.

## C8 — Lifecycle exceptions

Top-up, restructuring, write-off, closure as event-sourced processes with
approval and accounting treatment. No destructive updates to loan history.

## C9 — Reports & documents on the existing engines

Portfolio, outstanding principal/interest, daily/officer/branch collections,
arrears aging and PAR, client statement and exposure, applications/approvals/
disbursements. Documents: loan agreement, repayment schedule, loan statement,
payment receipt, disbursement confirmation, collection receipt. Existing
renderers reused with institution data injected.

## C10 — Hardening + one bulk sweep

RLS/grants audit on every `mf_*` table, reversal/duplicate/approval controls,
security scan. Then one grouped drop of confirmed-dead ERP schema (retail/WMS,
payroll, attendance, procurement, POS) plus deletion of their dead code and
inherited failing tests — after nothing reads them.

## Working rules

1. Financial state is derived server-side; React never owns balances, interest,
   arrears, allocations or journal amounts.
2. Every domain action is a business event with an accounting hook, not a CRUD
   update. Account mappings stay configuration — never a hardcoded account UUID.
3. Every new public table ships GRANTs + RLS + policies in the same migration;
   migrations stay small and single-purpose.
4. Inherited ERP rows are not this institution's data — no microfinance surface
   reads legacy invoices, bills, POS, payroll, CRM or inventory rows.
5. Permanently out of scope: SaaS/tenants/subscriptions/platform admin, payroll,
   attendance, POS, inventory, warehouse, procurement, sales order-to-cash,
   client portal, public registration, hardware estate.
6. Per-milestone verification is typecheck + open the affected screens. Full
   suite green is a C10 goal.
7. No exploratory audits of code or tables already known to be out of scope.

## Next action

Finish C4: create `src/apps/lending/products/ProductsPage.tsx` (product list,
status filter, opening the two existing dialogs), replace the `products`
placeholder in `src/apps/lending/routes.tsx`, typecheck, open
`/lending/products`. Then start C5 (applications → assessment → approval).




=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======


I paused here — the C7 repayment backend is in place, but the UI work is still pending.

Done this turn
- Repayment schema: `mf_allocation_policy` (configurable allocation order, not hardcoded), `mf_repayment_batches` (per-meeting collection), `mf_repayments` (receipts), `mf_repayment_allocations` (server-written only) — all with GRANTs, RLS and role-scoped policies.
- Server-side engine: `mf_record_repayment` (oldest-installment-first, allocates per the configured order, holds overpayment as advance, auto-closes a fully repaid loan, writes a loan event) and `mf_reverse_repayment` (append-only reversal, restores loan status, admin/branch-manager only).
- Derived views: `mf_loan_installment_status` and `mf_loan_balances` (outstanding principal/interest/fees, amount overdue, DPD, next due date) — no financial maths in React.

Remaining for C7
1. `src/hooks/useMfRepayments.ts` — list receipts, batch capture, `mf_record_repayment` / `mf_reverse_repayment` mutations, plus a `useMfLoanBalances` read of the new views.
2. `RepaymentsPage.tsx` (batch-per-meeting capture with per-member receipts, reversal) and `CollectionsPage.tsx` (arrears/DPD/PAR by officer portfolio), replacing the two placeholders in `src/apps/lending/routes.tsx`.
3. Optional: allocation-order setting on the lending configuration screen.
4. Then typecheck and open both screens; update `.lovable/plan.md` and move to C8.

Note: the linter warnings listed are inherited AccrualFlow issues (SECURITY DEFINER views/functions, extensions in public) — the new `mf_*` tables all ship RLS and policies; that cleanup is the C10 hardening sweep.


NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
