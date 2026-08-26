# Consolidation Module — Architectural Investigation & Verdict

## 1. Executive verdict

**What it is.** `Settings → Insights → Consolidation` (`src/apps/platform/nav.ts:74` → route `/reports/consolidation`, `src/App.tsx:365`, page `src/pages/reports/Consolidation.tsx`) is an honestly-labelled **cross-company comparative P&L**: one column per business, each in its own books and currency, no totals, no eliminations. Its own header comment says so, and the UI repeats it.

**Is it legitimate?** Yes. Side-by-side unconsolidated multi-entity reporting is a real, distinct capability in mature systems (it is essentially all QuickBooks Online Advanced offers, and what Odoo's plain multi-company mode gives before the Consolidation layer). It is *not* GAAP/IFRS consolidation, and the page correctly refuses to claim otherwise.

**Is it different from Finance reporting?** Conceptually yes — but **in implementation it is a second, independent accounting computation, and that is the one genuine architectural defect.** Finance reporting runs through an authoritative SQL engine (`get_general_ledger`, `get_account_movements`, `get_ledger_opening_balances`, `get_equity_result`, `finance_cash_flow_statement`, all `SECURITY DEFINER` and scope-gated). The Consolidation page bypasses all of it and re-sums `journal_entry_lines` in JavaScript (`Consolidation.tsx:79-119`). Two engines, two possible answers for the same P&L.

**Is the Settings placement justified?** Only partly. Mature systems universally split *consolidation configuration* (admin/setup) from *consolidated/group reports* (reporting area). Here there is no configuration at all — the page is 100% report — so it currently sits on the wrong side of that line. It is grouped under Settings → **Insights** alongside Audit Logs and Compliance, which is a defensible "admin-only oversight" reading, but the report itself belongs in Finance reporting with an owner/multi-company gate.

**Complete, partial, or scaffolded?** Scaffolded-but-working by design. There are **zero consolidation tables, functions, or migrations** in the database. Everything is client-side.

**Is anything actually wrong?** Three things: (a) duplicate accounting math outside the authoritative engine; (b) the business list is read straight from `businesses` filtered only by `organization_id` (`BusinessContext.tsx:152/172`) rather than the existing `get_user_allowed_businesses` RPC, so company visibility relies on downstream RLS rather than an explicit permission check; (c) "Failed to load report" — root cause **not yet confirmed** (see Phase 0).

## 2. What mature ERP systems do (verified from official docs)

- **NetSuite OneWorld** — subsidiary hierarchy; a dedicated *Consolidated Exchange Rates* table with **Current / Average / Historical** rate types; **elimination subsidiaries** plus Automated Intercompany Management. Core to the SKU.
- **Dynamics 365 Finance** — a designated *consolidation legal entity*, elimination rules, account mapping across different charts of accounts, currency translation; setup is configuration, output is Financial reporting.
- **Oracle Fusion** — core GL only *combines* books (ledger sets, reporting currencies); real group consolidation with ownership/eliminations lives in the **separate** Financial Consolidation and Close product.
- **Workday** — company hierarchy with ownership %, intercompany/interworktag elimination rules, and natively bundled CTA, NCI and equity pickup.
- **Odoo** — Accounting → Configuration → Consolidation holds account mapping; a separate consolidation journal produces output. Plain multi-company has no eliminations.
- **QuickBooks Online Advanced** — multi-company is spreadsheet roll-up (Spreadsheet Sync), no eliminations, no CTA. True consolidation is pushed to a higher tier.

Standards baseline: IFRS 10 / ASC 810 (scope and control), IAS 21 / ASC 830 (closing rate for assets & liabilities, average rate for P&L, historical for equity, difference to **CTA**).

## 3. What our codebase actually does

```text
Organization (tenant, RLS boundary)
  └── Business  = the accounting entity: owns COA, GL, fiscal periods,
                  base_currency (locked once a JE exists), tax rates
        └── Branch = sub-ledger dimension only — no currency, no ledger
```

- No `legal_entities`, no `parent_business_id`, no ownership %, no consolidation scope, no elimination or intercompany tables. `ARCHITECTURE.md:79-84` states intercompany is deliberately "not modelled in v1".
- Currency: transaction currency stamped and made immutable at posting; functional currency per business; presentation currency is a display-only user preference; single dated rate book with **no rate-type taxonomy** and **no CTA account**. Unrealized FX revaluation (`revalue_fx_balances`) exists and is solid.
- Isolation is sound: reporting RPCs self-gate via `finance_can_read_scope` (org membership + `user_can_access_business`, and for unscoped runs access to *every* business in the org); `accounts` / `journal_entries` / `journal_entry_lines` RLS all require `user_can_access_business`, with an existing `finance.view_consolidated` finance permission for branch-spanning reads. The Consolidation page's `owner`/`super_admin` check is presentation-layer only, sitting on top of that.
- `useFinancialReport` / `useCashFlowReport` deliberately return `requiresConsolidation: true` and refuse to compute when several businesses are in scope — a correct, conservative guard.

## 4. Architecture comparison

| Capability | Ours | Odoo | NetSuite | Oracle | D365 | Workday |
|---|---|---|---|---|---|---|
| Multi-company books | Yes | Yes | Yes | Yes | Yes | Yes |
| Comparative side-by-side | Yes (this page) | Yes | Yes | Ledger sets | Yes | Yes |
| Consolidated P&L / BS | No | Consolidation app | Yes | FCC | Yes | Yes |
| FX translation (avg/closing/hist) | No rate types | Partial | Yes | FCC | Yes | Yes |
| CTA equity account | No | Yes | Yes | Yes | Yes | Yes |
| Parent/subsidiary hierarchy | No | Yes | Yes | Yes | Yes | Yes |
| Intercompany accounting | No | Partial | Yes | Yes | Yes | Yes |
| Eliminations | No | Yes | Elim. subsidiaries | FCC | Rules | Rules |
| Minority interest | No | No | No | FCC | Yes | Yes |
| Account mapping across COAs | No | Yes | Yes | Yes | Yes | Yes |
| Separate consolidation config area | No | Yes | Yes | Yes | Yes | Yes |

## 5. What is genuinely missing

- **Required (only if group consolidation is a product goal):** entity hierarchy with ownership %, consolidation scope, exchange-rate types (average/closing/historical), CTA equity account, account mapping, consolidation run + audit trail.
- **Important:** intercompany trading-partner dimension on journal lines; a single reporting engine used by every report.
- **Advanced:** elimination journals, investment/equity eliminations, consolidated cash flow.
- **Optional / later:** minority interest, equity pickup, differing fiscal calendars across entities.
- **Already implemented elsewhere:** per-company P&L/BS/TB/cash-flow, opening balances, retained earnings, comparatives, branch and analytic dimensions, FX revaluation, tenant isolation.
- **Not needed now:** branch-level consolidation — branches are not legal entities.

## 6. What should NOT be changed

- The Organization → Business → Branch model, and business-owned COA/GL/calendar/currency.
- The `base_currency` immutability lock and the single server-side rate resolver.
- `SECURITY DEFINER` + `finance_can_read_scope` gating; the requirement that an unscoped run needs access to every business.
- The `requiresConsolidation` guard in the finance hooks — do not "fix" it by silently summing companies.
- The honest UI disclaimer. Do not rename this page "Consolidation" in the GAAP sense.
- Do not build eliminations before the entity/currency foundations exist.

## 7. Recommended target architecture

```text
Organization (tenant)
   └── Business / Legal entity ── GL ──► Finance reporting engine (SQL, authoritative)
                                            ├─► single-company statements
                                            └─► comparative multi-company view
        [future] group hierarchy + ownership %  ─► Intercompany  ─► Consolidation run
                                                                     └─► consolidated statements
```

Configuration (hierarchy, ownership, presentation currency, rate types, account mapping, elimination rules) belongs in Settings. Every report — comparative today, consolidated later — belongs in Finance reporting and must read from the one SQL engine.

## 8. Phased recommendation (derived from this codebase)

- **Phase 0 — diagnose (no schema change).** Capture the real PostgREST error behind "Failed to load report" (the page shows the raw message; the generic string only appears for non-`Error` throws). Confirmed already: the `journal_entries` embed has exactly one FK so the embed is fine, and the current tenant has one business per organization. Prime suspects are RLS on the `business_id IS NULL` shared-account branch and the module-permission check on `accounts`.
- **Phase 1 — single source of truth.** Re-point the comparative view at `get_general_ledger` / `get_account_movements` per business instead of client-side summation, and source the company list from `get_user_allowed_businesses`. Behaviour unchanged, divergence removed.
- **Phase 2 — placement.** Move the report into Finance reporting (multi-company gated); leave a Settings entry only once real configuration exists.
- **Phase 3 — foundations.** Entity hierarchy (parent/subsidiary, ownership %, consolidation scope) and exchange-rate types + presentation currency + CTA account.
- **Phase 4 — FX translation** of each entity's statements into a presentation currency.
- **Phase 5 — intercompany.** Trading-partner dimension and intercompany identification.
- **Phase 6 — eliminations and consolidated statements**, as versioned, auditable consolidation runs with drill-down.

Phases 3-6 should only start if group consolidation is genuinely on the product roadmap. Phases 0-2 are worth doing regardless.


==================PROGRESS STATUS===============================
Phase 3 foundations are partly landed. Here's where things stand:

Done and verified in the database

consolidation_groups — parent company + presentation currency, org-scoped, RLS (members read, owner/admin/super-admin write), guard trigger for org match and valid currency.
consolidation_group_members — ownership %, consolidation_method enum (full/proportional/equity/excluded), effective dating, plus guards for same-org, no ownership cycles, and control test for full consolidation.
consolidation_exchange_rates — separate group rate book with closing/average/historical rate types, unique per group/pair/type/period, forced to translate into the group's presentation currency. Day-to-day exchange_rates untouched.
CTA registered as a real account role (cumulative_translation_adjustment, equity) with eligibility rows, and surfaced in the Default Accounts config UI.
Written but not yet wired or checked

src/hooks/finance/useConsolidationGroups.ts and src/components/settings/ConsolidationGroupsSettings.tsx exist, but the "Consolidation" tab has not been added to src/pages/settings/WorkspaceSettings.tsx, so the UI is currently unreachable, and no build/typecheck has run since these files were created.
Next steps for whoever resumes

Add a consolidation tab to WorkspaceSettings.tsx (gate on permissions.canManageOrganization and hasMultipleBusinesses) rendering <ConsolidationGroupsSettings />; then verify the build and the new tab in preview.
Update .lovable/plan.md to record Phase 3 as active/partly complete (schema done, UI pending) — that update was not made.
Only then start Phase 4 (FX translation into the presentation currency using the new rate types and CTA account).
