# ADR 0005: HR/Payroll split, entitlement architecture, and edge-function consolidation

Status: Accepted
Date: 2026-04-25

## Context

The platform was approaching the 100 edge-function ceiling (94 used) and had
several architectural gaps surfaced during a zero-trust audit:

1. The HR domain was modelled as a single monolithic app, even though the
   product is sold as five distinct Odoo-aligned apps (Employees, Time Off,
   Attendance, Timesheets, Payroll, Recruitment).
2. Subscription upgrade copy was hardcoded ("upgrade to a higher plan") even
   though a `cheapest_plan_for_app` RPC existed and could give exact pricing.
3. The `/apps` marketplace was admin-only, breaking cross-app deep links and
   the Odoo discovery experience for non-admin tenant users.
4. Several payroll/HR tables had no `assert_app_installed_for_write` trigger,
   so a stale token could mutate data after an org uninstalled the owning app.
5. Three domains (M-Pesa, eTIMS, spreadsheet-AI) had heavy fragmentation —
   between them they accounted for 18 edge functions.

## Decision

### 1. HR is five apps, not one

`employees`, `time-off`, `attendance`, `timesheets`, `payroll`, `recruitment`
are modelled as independent `AppDefinition`s with `dependsOn: ["employees"]`
on every dependent. URLs continue to live under `/hr/*` for back-compat (deep
links, edge function callbacks, email links), but each subtree is wrapped in
`<AppInstalledGate>` so an uninstalled sub-app cannot leak its workspace.
`HR_APP` is kept as a deprecated alias to `EMPLOYEES_APP`. New code MUST NOT
reference `HR_APP`.

### 2. Five-state entitlement matrix

Every app is in exactly one of: **not_installed**, **installed (paid)**,
**installed (trial)**, **dependency_missing**, **plan_required**. The matrix
is enforced in three layers:

| Layer       | Where                                                       | Failure mode                                  |
|-------------|-------------------------------------------------------------|-----------------------------------------------|
| Frontend    | `useAppLifecycle.getAction()`, `<AppInstalledGate>`         | Routes to install / trial / subscribe / activate page |
| Backend RPC | `assert_entitlement`, `has_app_entitlement`                 | Throws on RPC call                            |
| Database    | `assert_app_installed_for_write` triggers + RLS             | Throws on INSERT/UPDATE/DELETE                |

`cheapest_plan_for_app(app_id)` is used by `useCheapestPlanForApp` to render
upgrade copy with real plan name and price (e.g. "Upgrade to Professional
($29/mo) to unlock Payroll").

### 3. Marketplace is open, install actions are gated

`/apps` is browsable by all authenticated tenant users. `install`,
`start_trial`, `subscribe`, and `uninstall` actions remain restricted to
users with the `manageApps` permission. Non-admin users hitting `/apps/{id}/
activate` see a "Request access from your admin" surface that calls the
existing `request_app_access` RPC.

### 4. Trigger gaps closed

`assert_app_installed_for_write` now covers the full payroll/HR write
surface: `employees`, `employee_contracts`, `payroll_periods`,
`payroll_remittances`, `payroll_statutory_rules`, `leave_types`, and
`work_schedules`. Reads stay open via RLS (historical access preserved) — only
writes are blocked when the owning app is uninstalled.

### 5. Edge-function consolidation strategy

| Domain              | Before | After | Strategy                                                    |
|---------------------|--------|-------|-------------------------------------------------------------|
| Spreadsheet AI      | 3      | 1     | `spreadsheet-ai-gateway` with `?action=ai|chart_ai|pivot_ai`|
| M-Pesa outbound     | 3      | 1     | `mpesa-outbound` with `?action=stk_push|query|simulate_callback` |
| M-Pesa callbacks    | 4      | 4     | **Unchanged** — Safaricom-registered URLs                   |
| eTIMS               | 6      | 6     | **Deferred** — large, KRA-compliance critical               |

**Net: 94 → 88 edge functions (12 slots free before the 100 ceiling).**

Inbound callbacks (`mpesa-callback`, `mpesa-c2b-confirmation`,
`mpesa-c2b-validation`, `mpesa-subscription-callback`) are intentionally
**not** consolidated: their URLs are registered with Safaricom externally and
renaming would break in-flight payment flows.

eTIMS consolidation is deferred for a separate, audited release because each
function is large (~300-470 LOC), uses different KRA endpoints, and is on a
compliance-critical path. The pattern from `mpesa-outbound` is reusable when
that work is scheduled.

## Consequences

### Positive
- Five HR apps unlock independent pricing, trials, and uninstallation.
- Upgrade copy now communicates real plan names and prices.
- Non-admin users can discover apps and request access without dev intervention.
- Write-side data integrity is enforced regardless of the UI layer.
- Edge-function count is back below the 100 ceiling with room for ~12 more.

### Negative / Trade-offs
- Two extra dispatcher functions (`spreadsheet-ai-gateway`, `mpesa-outbound`)
  add a small switch overhead (~1ms) per request.
- Callers must include `action` in the body (or `?action=` in the URL) to
  select the operation. A typo silently 400s instead of routing to the wrong
  endpoint.
- `HR_APP` and `MODULE_TO_APP_MAP.hr` legacy aliases are still present to
  keep older Access Group rules working. They should be removed in a future
  migration once the DB is audited for any rules still referencing the legacy
  `hr` module.

## Notes for future work

- When eTIMS consolidation is taken on, model it after `mpesa-outbound`.
  Keep all KRA-registered callback URLs untouched.
- The next domains likely to grow are `send-*-email` (12 functions) and
  `process-*` automation (5 functions). They already share the same general
  shape and would consolidate cleanly if the ceiling becomes a concern again.
