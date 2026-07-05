
# Continuation plan — HR Employee subsystem audit

## Verification of prior work

I re-audited the codebase against the previous agent's claims and the original plan (`.lovable/plan.md`).

**Verified as genuinely shipped (Wave A step 1 — Lifecycle):**
- `src/hooks/hr/useLifecycleEvents.ts` (178 LOC) — real query over `employee_lifecycle_events` joined to `v_employees_canonical`, scoped through `useHrScope`. Not a stub.
- `src/pages/hr/lifecycle/LifecycleOverviewPage.tsx` (151 LOC) — 30-day cross-pipeline overview with per-family counts.
- `src/pages/hr/lifecycle/LifecyclePipelinePage.tsx` (150 LOC) — reusable queue grouping events by employee, showing latest state per person.
- `src/pages/hr/lifecycle/LifecycleTimelinePage.tsx` (168 LOC) — filterable cross-employee event log.
- `src/apps/hr/sub/LifecycleRoutes.tsx` — six pipelines (Onboarding / Probation / Transfers / Renewals / Offboarding / Archive) + Timeline are wired to real screens; only the index and family stubs (`WorkspaceComingSoon`) are gone.

Lifecycle no longer contains stubs. Step 1 is complete.

**Verified as still stubs (all of Contracts except overview):**
- `src/apps/hr/sub/ContractsRoutes.tsx` renders `WorkspaceComingSoon` for `all`, `drafts`, `pending`, `active`, `expiring`, `renewals`, `amendments`, `templates`, `audit`. Only `ContractsOverview.tsx` (324 LOC) is real.

The original architectural verdict in `.lovable/plan.md` still holds: schema, RPCs (`renew_contract`, `amend_contract`), `contract_amendments`, `employee_contracts`, `contract_compensation_components`, `employee_compensation_history` are all in place. The Contracts UI is the missing operator surface.

Waves B–H (Positions as funded roles, HR inbox expansion, Compensation cycle, Event-outbox choreography, Doc compliance loop, Recruitment→Employees, Exec analytics, Maintenance depth) remain untouched. That is correct sequencing — Wave A ships the highest-ROI operator surfaces first with no schema movement.

## Next slice — Wave A step 2: Contracts real screens

Replace `ContractsRoutes.tsx` stubs with operational workspaces over the existing `employee_contracts` + `contract_amendments` schema. No migrations, no schema changes, no RPC changes.

### Deliverables

1. `src/hooks/hr/useContracts.ts` — org/business-scoped query over `employee_contracts` joined to `v_employees_canonical`, with derived state (`draft` / `pending_approval` / `active` / `expiring_30` / `expiring_60` / `expiring_90` / `expired` / `terminated`) computed from `status`, `start_date`, `end_date`. Includes `contract_amendments` count per contract.
2. `src/hooks/hr/useContractAmendments.ts` — filterable read for the audit surface (by contract, employee, actor, date range) and thin wrappers over the existing `renew_contract` / `amend_contract` RPCs (write path).
3. `src/pages/hr/contracts/` new pages, each a real operator queue with KPI header, filters, and per-row drill-into-profile:
   - `ContractsAllPage.tsx` — every contract, faceted by state + type + department.
   - `ContractsDraftsPage.tsx` — status = draft, action: "send for approval".
   - `ContractsPendingPage.tsx` — status = pending_approval, action: "approve / return".
   - `ContractsActivePage.tsx` — status = active AND not expiring.
   - `ContractsExpiringPage.tsx` — 30/60/90 buckets; primary action: "renew" (opens existing amend/renew dialog).
   - `ContractsRenewalsPage.tsx` — amendments where `amendment_type = 'renewal'`, grouped by contract.
   - `ContractsAmendmentsPage.tsx` — all `contract_amendments`, timeline view.
   - `ContractsTemplatesPage.tsx` — reuses the existing contract-template surface if one already exists; otherwise a proper "not configured" empty state pointing at HR Policies (no fake CRUD).
   - `ContractsAuditPage.tsx` — full amendment timeline filterable by contract / employee / actor.
4. Wire all of the above into `ContractsRoutes.tsx`, delete every `ContractsStub` / `WorkspaceComingSoon` reference.
5. Update `ContractsOverview.tsx` KPI cards to link into the new queues (right now they navigate to stubs).

### Guardrails

- Reads go through the canonical view, never `employees` directly (ESLint arch guard already enforces).
- All writes reuse existing RPCs (`renew_contract`, `amend_contract`) — no new SQL.
- Scope via `useHrScope` so branch-restricted users see their assignments only; admins see the whole business (ADR-0039).
- No changes to `.lovable/plan.md` — it remains the source of truth for the full audit; this plan is only the next slice.

### Out of scope (still deferred, per waves B–H)

Positions-as-funded-roles, HR cross-module inbox expansion, document compliance loop, compensation cycle UI, `business_event_outbox` HR emitters, recruitment→employees hand-off, executive analytics, maintenance depth checks. Each is its own follow-up slice after Wave A finishes with step 3 (Directory saved operational views) and step 4 (HR inbox expansion).

## Technical details

- New files only under `src/pages/hr/contracts/` and `src/hooks/hr/`; `ContractsRoutes.tsx` edited in place.
- Expiry buckets computed with `date-fns` `differenceInDays(end_date, today)` and materialised into the query result so filters + counts share one source.
- Amendment writes trigger `queryClient.invalidateQueries(['contracts', ...])` and the lifecycle query key so the Lifecycle Renewals pipeline reflects the change without a reload.
- Each page uses the existing `PageHeader` / `PageBody` from `@/design-system` for visual consistency with the Lifecycle screens shipped in step 1.

Approve to proceed with Wave A step 2 (Contracts real screens).
