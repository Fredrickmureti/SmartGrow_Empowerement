# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-04 (second rework). One institution, employee-operated,
ASA-style: branch → loan officer → group → client, individual obligors,
staff-only, no client portal. Backend: Supabase `xwxqunklduknceoryrha`
(connected — never redo).

## Locked decisions — do not re-litigate

REUSE as infrastructure, retargeted to microfinance: auth + PIN + invitation,
document engine, navigation / app shell / UI system, Chart of Accounts +
journals + GL + fiscal periods, banking + reconciliation, payment settlement &
allocation engine, statements engine, fixed assets, company settings, audit
logging, reporting engine, storage, SMS.

OUT permanently: sales, purchases, POS, inventory, warehouse, CRM, projects,
HR, payroll, recruitment, localization/tax packs, marketplace/entitlements,
multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math; individual and group repayment share one
code path and one allocation policy; one migration = one purpose; never build
microfinance surfaces on legacy ERP rows; no exploratory audits, no standalone
reports, no cosmetic refactors.

## ERP strip is CLOSED

Schema is ~398 public tables (from 842). What remains of the old ERP is inert
(no nav, no hooks, no UI). **No further ERP-removal milestones**, except the
report-surface cleanup in M10 below (UI-only, no DB drops). Inherited linter
findings stay deferred.

## Verified state (2026-09-04, re-verified this session)

- Apps: `dashboard, finance, lending, platform, reports, studio`.
- Lending routes exist for clients, groups, products, applications, loans,
  repayments, collections, settings (accounting mappings + allocation policy)
  and nine report pages under `src/apps/lending/reports/`.
- `mf_post_event → mf_resolve_account → post_journal_entry_atomic` is the
  financial authority; balances, arrears, PAR, installment/penalty status and
  statements are DB views, all `security_invoker`, officer-scoped via
  `mf_officer_in_scope` / `mf_loan_in_scope`.
- Owner `fredrickmureti612@gmail.com` = `owner`, module `lending` granted.

### Completed milestones (M4–M9.5)
Collections & repayment (ASA group sheet + single-client, allocation policy,
client credit, receipts, cash handover → bank batch → reconciliation);
statements; arrears/PAR/delinquency; loan lifecycle events (top-up,
restructure, write-off, closure — events, never `UPDATE loans`); nine lending
reports through the existing engine (`src/hooks/useMfReports.ts`, server views
only); RBAC lending matrix in `src/lib/permissions.ts`; real penalties
(`mf_loan_charges`, `mf_loan_penalty_status`, `mf_accrue_penalties`, allocation
in policy order) and their surfacing on the loan schedule; disbursement and
repayment reversals with journal reversal; branding.

### Partially complete — loan fees (M9.7, DB done, UI open)
Verified in code: product versions publish `fees: []`
(`src/apps/lending/products/ProductVersionDialog.tsx:166`) so **no product can
yet carry a fee**. DB side is in place: fees configured per product version
(percent-of-principal or flat; deducted at disbursement or added to first
installment), frozen onto the loan at creation, `mf_compute_loan_fees` /
`mf_loan_fee_total` resolve amounts server-side, `mf_disburse_loan` stores
`fees_deducted`, `net_amount`, `fee_breakdown` and refuses fee ≥ principal.
Accounting is settled and correct: a 1,000 loan with a 200 fee posts
DR principal receivable 1,000 / CR fee income 200 / CR cash 800 — the client's
obligation stays 1,000; fee income resolves through the existing `fee_income`
mapping (Lending → Configuration → Accounting), no account UUIDs in code.

## Milestones remaining, in order

### M9.7 — Loan fees — DONE (verified 2026-09-04)
Fee editor publishes real `fees` on product versions; disbursement dialog shows
gross / fee lines / net cash; disbursement carries `fees_deducted`,
`net_amount`, `fee_breakdown`; documents show the fee breakdown. No client-side
fee math.

### M10 — Reporting catalogue is microfinance-only — DONE (verified 2026-09-04)
FX family and ERP domains/categories removed from the registry, nav and routes;
the four lending reports registered under `domain: "lending"`; `/reports` shows
the lending catalogue. DB objects untouched.

### M10.5 — ERP copy sweep — DONE (2026-09-04)
Auth surfaces retargeted: login hero (was "Invoicing, inventory, payroll and
point of sale") and signup company step now use microfinance language.

### M11 — Owner verification pass (preview only)
Authenticated checks cannot run from the sandbox (external Supabase). Sign in
as owner and confirm: a product with a 200 flat fee disburses 800 net with the
journal above; write off one loan and confirm the journal posts; reverse one
disbursement; `/lending` and children open; dashboard KPIs and PAR load; every
lending report renders and exports; one client statement, one repayment receipt
and one disbursement confirmation print (fee breakdown visible); a banked
collection matches in bank reconciliation; penalty accrual raises charges and
they show on the loan.

### M12 — Deferred inherited linter posture (last)
~2,021 pre-existing findings from the AccrualFlow history: SECURITY DEFINER
views, function `search_path`, anon EXECUTE revokes, leaked-password
protection. Nothing in the domain blocks on it; one fix per migration.

## Working rules
- Update this file after every milestone; factual and short.
- Every change must serve the microfinance domain or unblock it.

##M13  rework on studio to be microfinance tailored

##THEN GO FULL FOCUS ON MODE ON reports becaus there report pages still pinned on the previous achitectite and its showing works like invoicesm financial statements aree not showing they are showing error loading reports  etc 


##M14 work on the AI sider the superadmin can add AI api on the settings 


==========THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT==============

I paused the Studio retarget partway. Here's where things stand.

Done
- New single source of truth `src/lib/studio/entities.ts`: microfinance `EntityType` union (clients, groups, loan applications, loans, disbursements, repayments, collection activities, loan products, staff, expenses), labels, core-field catalogue, entity groups, reportable/financial/document sets.
- `src/hooks/useEntityFields.ts` now re-exports the type and labels from that module (ERP union removed).
- Retargeted: `CoreFieldsManager`, `ViewConfigPanel`, `ReportFieldSelectionManager` (now share the one catalogue), `SavedViewsManager` and `FormLayoutDesigner` entity icons, `ApprovalRulesManager` entity actions + defaults + copy, `AutomationBuilder` financial-model guardrail + default target, `AutomationTemplateGallery` category list.

Remaining
1. `src/components/studio/EntityFieldSettings.tsx` — `RELATED_MODEL_OPTIONS`/`RELATED_DISPLAY_FIELDS` still ERP (contacts, products, invoices…), and the document-placement gate at ~line 940 lists ERP entity types with invoice-flavoured section labels.
2. `src/components/studio/DocumentFieldPlacer.tsx` — section labels ("Customer Details", "After Items") need loan-document wording.
3. `src/components/studio/ScheduledReportsManager.tsx` — `REPORT_TYPES` still carries Sales/Purchases/POS/HR/Inventory report entries.
4. `src/data/automationTemplates.ts` — template `category` values and `categoryLabels` still use sales/crm/inventory/purchasing; must match the new category list.
5. `src/pages/studio/StudioFields.tsx` — should consume `ENTITY_GROUPS` from the new module.
6. Verification not yet run: `npx tsgo --noEmit -p tsconfig.app.json`, dev-server 200 check, and a preview pass over `/studio/*`. Expect type errors until items 1–5 land, since the `EntityType` union no longer contains the ERP keys.


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
