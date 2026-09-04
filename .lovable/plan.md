# Smart Grow Empowerment — Microfinance Platform (authoritative execution plan)

Backend: Supabase `xwxqunklduknceoryrha`, connected. No connection work remains.

## Locked decisions (do not re-litigate)

Reused from the inherited codebase: document generation engine · auth / PIN /
invitation engine · navigation, app shell and UI system · report engine ·
company/institution settings · audit logging · storage · finance core (Chart of
Accounts, journals, GL, fiscal periods, fixed assets, banking + reconciliation,
payment settlement engine — all retargeted to lending, not sales).

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, multi-tenancy, client portal.

Architecture invariants:
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears and PAR are DB views.
- Every state change is a business event; never `UPDATE loans SET …`.
- Account mapping stays configurable; no account UUIDs in React.
- One migration = one object group. Never batch multi-object SQL.

## Verified state (read from the codebase, 2026-09-04)

Verified complete:
- Apps: `dashboard, finance, lending, platform, reports, studio`. No ERP
  sales/purchases/POS/inventory/HR pages remain under `src/pages`.
- Lending domain live end-to-end: clients, groups, loan products, applications,
  assessment/approval, loans, disbursement, schedule engine, repayments
  (ASA group sheet **and** single-client payment), collections, arrears/PAR,
  top-up / restructure / write-off / closure as distinct events, penalties with
  policy-ordered allocation, officer data scope, reversal & duplicate guards.
- Report catalogue is microfinance-only: 24 registry entries across
  `lending, statutory, cash_bank, audit, management, fixed_assets`. FX
  (revaluation / exposure / realized), aged receivables and aged payables are
  gone from the registry, nav, search and routes. Nine lending reports routed.
- Finance ERP surfaces removed: `receivables` / `payables` routes and pages,
  customer-invoice / vendor-bill dashboard cards, ERP command-palette actions.
- Studio entity catalogue is microfinance-only (`mf_*`, `employee`, `expense`).

Fixed this session (was blocking the build):
- `StudioFields.tsx`, `FormLayoutDesigner.tsx`, `SavedViewsManager.tsx` still
  carried the ERP entity list (contact / invoice / sales_order / bill / product).
  Icon maps, entity groups and defaults now come from
  `src/lib/studio/entities.ts`. Typecheck clean, build OK.

Known residue, deliberately left inert (removing it costs more than it returns):
delivery notes, sales orders, recurring invoices, sales returns and eTIMS
identifiers remain in the shared document/outbox/audit/studio metadata. No
navigation, no hooks, no UI reaches them.

## Remaining milestones, one at a time

### N1 — Owner verification pass (next, blocks nothing else)
Sandbox cannot mint a session against the external Supabase project, so the
owner confirms in the preview: `/lending` and children open; dashboard KPIs and
PAR render; one report, one client statement, one repayment receipt and one
disbursement confirmation render through the shared document engine. Any failure
found here is fixed before N2.

### N2 — Dead ERP table groups (DB slimming)
One migration per group, FK-ordered: inventory/WMS → purchasing →
sales/POS/CRM → projects → marketplace. Keep auth, org/branch, finance core,
banking, documents, reporting, audit, `mf_*`. Verify counts after each.

### N3 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches by group. Never touch `mf_*`. Confirm no trigger on a
live table depends on a function before dropping it.

### N4 — Linter posture on what remains
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes,
leaked-password protection — retained schema only.

### N5 — Domain depth (only if the owner asks)
Savings, regulatory returns, cash-management/teller sessions. Not in scope until
requested.

## Working rules
- No second implementation where a mature engine exists.
- No frontend-authoritative financial math.
- Do not audit, document or polish anything outside microfinance scope.
- Update this file after each milestone; keep it short and factual.


==========THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT==============

Paused here — a summary of where things stand.

Done this session (N2 started):
- Dropped dead ERP table groups in two migrations: consolidation module (14 tables + `one_on_ones_visible` view), HR extras (kudos, one-on-ones, quizzes, retro pay, termination payouts, HR policies/doc categories, holidays), retail/POS leftovers (prescriptions, promotions, loyalty), warehouse leftovers (replenishment, scrap, count tolerance), and the scanner/workstation group.
- Removed the now-orphaned code: consolidation settings components, three consolidation hooks, elimination remedies lib, the consolidation section in Finance Settings, and four obsolete architecture tests. Typecheck is clean.

Remaining:
- N2 continued: sales chain (invoices, sales orders/returns, credit notes, delivery notes, estimates, proforma, recurring invoices, customer credits/statements, dunning, AR disputes), purchasing chain (bills, bill payments/matching, vendor credits/refunds/statements), CRM `contacts`, projects, cost layers, backorders/carriers, FX and eTIMS tables. Each needs the matching hooks/pages deleted in the same step — these still have live code references, unlike the groups already removed.
- N3 orphan function purge, N4 linter posture (2025 findings are pre-existing, mostly SECURITY DEFINER EXECUTE grants and function `search_path`), N5 only if requested.
- `.lovable/plan.md` and `roadmap.md` still need updating to mark the first N2 batches complete.


=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**
* *Banking and reconciliation , payables receivables but now tailored for microfinance**
TO BE PRECISE, WHAT IS REUSABLE, KINDLY REUSE IT INCLUDING PAYMENT SETTLEMENT ENGINE FOR PAYABELES/RECEIVABLES, basically accross the Finance what is reusable use it as long as its microfuiannce tailored because we are building mciro fianance  if its statements instead of customer staments lest it be  talowred towards microfinance not the current sales oriented that was used by the old erp so dont just delete what is reusable and has solid engine that will be painful to rebuild from scratch, reason like a mircofiannce system developer not like a blind bot,  and  if its payment being receuived,  and on the payment reception we need to reason critically here because this sytem is almost operating almost like ASA international kenya which uses the typical old microfinance tradition because this is an upcoming microfiannce startapp  where we have something loan officer overseeign a group but still that does not mean tje system should not allow single customer payment so this means I need you to help me reason here, dont ask me question, just know you are dealign with a microfiannce system  and such not the old erp which dealth with the typical procurement and sales kind of flow no room for an error, be anaytical and critical executioner, like basically for fiannce what can be reusable let it be reused and now be tailpored to the microfiannce from  fixed assets, to generaal settings to fiscal periods and such (its up to you to analyze what and what nots that needs  to be retained because you are the engineer)

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**

## Status update (M3, pricing group)

Done: removed the sales pricing engine — line-pricing triggers on invoice /
estimate / credit-note / proforma / sales-order items, `_pricing_normalize_line`,
`resolve_line_unit_price`, `pos_resolve_line`, the `contacts.customer_group_id`
and `contacts.price_list_id` columns, and the `customer_groups`, `price_lists`,
`price_list_items` tables. Code side (`fetchContactDefaults`, `useContacts`)
cleaned; typecheck green. Linter count 2025 -> 2021, all inherited, none new.

Scope decision (deliberate, to avoid credit burn): delivery notes, sales orders,
recurring invoices, sales returns and the eTIMS group are NOT worth a deep
schema scrub — their identifiers are woven through the shared document engine,
outbox, audit and studio metadata that we are keeping. They are left inert
(no navigation, no hooks, no UI). Next work goes to microfinance business logic:
retargeting receivables/payables and the payment settlement engine to loans,
group/individual collections, and microfinance-tailored statements.

## Report catalogue retargeted to microfinance (done 2026-09-04)

- `REPORT_REGISTRY` categories/domains reduced to microfinance-relevant sets:
  categories are now lending, statutory, cash_bank, audit, management,
  fixed_assets; domains are finance + lending only (hr/sales/purchases/
  inventory/pos/projects/crm removed).
- Removed orphaned ERP reports from the catalogue, nav and search: FX
  Revaluation, FX Exposure, Realized FX Gain/Loss, Aged Receivables, Aged
  Payables (the FX *pages/routes* stay only because period-close tooling links
  to them; they are no longer part of the report catalogue).
- Added the remaining lending reports to the registry (officer & branch
  collections, PAR aging, product performance, client exposure) so palette,
  favorites, run history and permissions apply to them.
- Reports sidebar now leads with a "Lending & portfolio" family; the FX and
  Receivables/Payables families are gone. Report Center quick access defaults
  to portfolio / arrears / collections.





DO NOT ASK ME ACHITECTURAL QUESTIONS , YOU ARE THE ENGINEER, YOU HAVE THE CODEBASE, YOU KNOW WHATW E ARE BUILDING SO REASON CRITICALLY AND ANALYTICALLY 
