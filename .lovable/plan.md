# Smart Grow Empowerment — Microfinance Platform (execution plan)

Backend: Supabase `xwxqunklduknceoryrha`, already connected. No connection work remains.

## Verified now (read from the codebase, not from the old log)

- Apps shipped: `dashboard, finance, lending, platform, reports, studio`. No ERP
  sales/purchases/POS/inventory/HR pages remain under `src/pages`.
- Lending app is real: clients, groups, products, applications, loans, repayments,
  collections, documents, settings, plus **9 lending report pages** on the shared
  report engine (`src/apps/lending/reports/*`).
- Report registry is already microfinance-shaped: categories are
  `lending, statutory, cash_bank, audit, management, fixed_assets` — no FX or
  inventory category remains, and the 9 lending reports are registered.
- **Orphans confirmed**: `/finance/reports/fx-revaluation`, `fx-exposure`,
  `fx-realized` are still routed in `src/apps/finance/routes.tsx` with three
  page files, but are in no registry, no nav — dead ERP surface reachable by URL.
  `/finance/reports/aging` (ERP receivables aging) is likewise routed but
  unregistered, and duplicates the lending PAR-aging report.
- Financial authority is server-side (`mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`); balances/arrears/PAR are views. Correct pattern.
- Database is still heavy: ~398 tables and ~2,800 functions, most belonging to
  the dead ERP groups (inventory/WMS, purchasing, sales/POS/CRM, projects,
  marketplace) and ~1,400 functions referencing relations that no longer exist.

## What is reused (locked, do not re-litigate)

Document generation engine · auth/PIN/invitation engine · navigation, app shell
and UI system · Chart of Accounts + journals + GL + fiscal periods · report
engine · company/institution settings · audit logging · storage.

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, multi-tenancy, client portal.

## Milestones, in order — one at a time, verify before the next

### M1 — Report and route cleanup (small, do first)
- Delete the FX report routes and the three FX page files; delete the ERP
  `reports/aging` route and page (PAR aging is the microfinance equivalent).
- Sweep `src/apps/finance/routes.tsx` and `FINANCE_NAV` for any other route not
  present in `REPORT_REGISTRY`, and remove it.
- Rename the residual ERP framing in Finance nav where it is only ERP wording
  ("Loan receivables" / "Institution payables" stay only if they are backed by
  microfinance data; otherwise the entries go).
- Exit: typecheck clean, every remaining `/finance/reports/*` and
  `/lending/reports/*` route is a registry entry.

### M2 — Dead ERP table groups
One migration per group, FK-checked, in this order: inventory/WMS → purchasing →
sales/POS/CRM → projects → marketplace. Keep auth, org/branch, finance core,
banking, documents, reporting, audit, `mf_*`.

### M3 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches by group. Never touch `mf_*`. Confirm no trigger on a
live table depends on a function before dropping it.

### M4 — Linter posture on what remains
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes,
leaked-password protection — only for retained schema.

### M5 — Microfinance domain depth (one milestone each)
1. Top-ups and restructuring as distinct business events (never `UPDATE loans`).
2. Write-off: approval control + accounting treatment.
3. Collections field workflow: visits, promises to pay, outcomes.
4. Retarget the Finance dashboard figures to portfolio metrics.

## Owner verification (parallel, preview only)
Sandbox cannot mint a session against the external Supabase project, so the
owner confirms in the preview: `/lending` and children open; dashboard KPIs and
PAR render; one report, one client statement, one repayment receipt and one
disbursement confirmation render through the shared document engine.

## Working rules
- One migration = one object group. Never batch multi-object SQL.
- No second implementation where a mature engine exists.
- No frontend-authoritative financial math.
- Do not audit, document or polish anything outside microfinance scope.
- Update this file after each milestone; keep it short and factual.


==========THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT==============


Stopping here. Summary of where things stand:

Done
- M1 report cleanup finished: dead FX/aging routes, pages and links removed; a dead consolidation link removed from `CompanyScopeGate`; the architecture test referencing the deleted `AgingReport.tsx` updated — report tests pass.
- ERP AR/AP surfaces removed from Finance: `receivables`/`payables` routes and nav items, `AccountsReceivable.tsx`/`AccountsPayable.tsx` pages, and the Customer Invoices / Vendor Bills dashboard cards plus their quick actions.
- `src/lib/command/actions.ts` rewritten to a microfinance action registry (lending, accounting, contacts).

Outstanding (blocking typecheck)
`src/pages/studio/StudioFields.tsx`, `src/components/studio/FormLayoutDesigner.tsx` and `src/components/studio/SavedViewsManager.tsx` still reference the old ERP entity list (`contact`, `invoice`, `sales_order`, `bill`, `product`, `project`, …), while `src/lib/studio/entities.ts` now only defines microfinance `EntityType`s. These three files need their entity groups, icon maps and casts narrowed to the `mf_*`/`employee`/`expense` union before the build is green.

Then
Database slimming (M2): the sales cluster can't be dropped without also removing invoices, credit notes, delivery notes, estimates and projects, which hold FKs to it — that whole order-to-cash cluster should go in FK-ordered, one-group-per-migration steps, after the code surfaces above are gone.


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
