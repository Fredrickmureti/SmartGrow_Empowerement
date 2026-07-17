
## Root cause (proven, not assumed)

The "Project field on Sales Invoice after Projects is uninstalled" symptom is one visible instance of a **system-wide architectural gap**: modules integrate with each other via **direct ES imports**, not via a capability contract mediated by the app registry.

Evidence gathered:

- `src/features/sales/invoices/InvoiceCreatePage.tsx` (and `InvoiceEditPage`, `SalesOrderCreatePage`, `SalesOrderEditPage`, `purchases/bills/*`, `purchases/orders/PurchaseOrderEditPage`, `purchases/expenses/ExpenseFormFields`, `pages/Expenses.tsx`) statically import `@/components/projects/ProjectPicker`, `@/components/projects/LineAnalyticsCell`, `@/components/projects/TaskPicker`. None of these call `isInstalled("projects")` or any capability check (verified: `rg "isInstalled\(" src/features/sales src/features/purchases src/features/finance src/pages/Expenses.tsx` returns zero hits).
- `src/lib/apps/registry.ts` supports only **hard** `dependsOn` (e.g. Payroll → Employees). There is **no** concept of a *soft/optional* capability that Sales can consume when Projects is present.
- `src/lib/apps/module-app-map.ts` is an RBAC visibility layer for whole apps in the launcher — it does **not** gate cross-app UI extensions inside other apps.
- `AppInstalledGate` guards **routes into an app**, not **widgets embedded elsewhere**. Uninstalling Projects removes `/projects/*` access but leaves the `<ProjectPicker>` mounted on every Sales/Purchases form.
- `useProjects()` still fetches on demand — with Projects uninstalled the query returns an empty list, so the field appears "required but empty", which is exactly the reported symptom.
- The `uninstall_app` RPC (supabase/functions/app-lifecycle) removes the install row and dependency edges but does **not** deregister any UI extensions or emit a "capability revoked" event, because no such concept exists in the codebase.

**Conclusion:** the ProjectPicker is a symptom. The same latent flaw exists at every point where one app embeds another app's component, hook, or query. A grep for cross-app imports shows this pattern is widespread (projects → sales/purchases/finance; HR sub-apps → finance; POS → inventory/sales; etc.).

## How mature ERPs solve this

- **Odoo** — modules declare `depends` (hard) and use view inheritance with `groups=`/`states=` attributes and `ir.module.module` state checks; uninstalling a module removes its views and XML-inherited fragments from parent forms via the ORM. Optional integrations live in glue modules (`sale_project`, `account_analytic`) that only load when both sides are installed.
- **Dynamics 365** — solution layering + feature flags gated on installed solutions; extensions register via extension points, not direct references.
- **SAP S/4** — BAdIs (Business Add-Ins) are named extension points; consumers query the BAdI manager at runtime.
- **NetSuite** — SuiteApps register UI/scripting hooks; when the SuiteApp is uninstalled, hooks are dropped from the metadata cache.

**Common pattern:** a **capability/extension-point registry** with runtime resolution, and a lifecycle contract that adds capabilities on install and removes them on uninstall. Consuming code asks "is capability X available?" rather than importing from the providing module.

## Deviations in our codebase

1. No capability registry. `AppDefinition` has `dependsOn` (hard) but no `provides: Capability[]`.
2. Cross-app widgets are imported statically → they ship in the consumer's bundle and render regardless of install state.
3. Uninstall lifecycle removes DB rows but does not invalidate consumer-side integration points (no event, no cache bust for capability queries).
4. No lint rule prevents feature A from importing from feature B directly.
5. Data model keeps foreign keys like `invoices.project_id` populated forever; there is no policy for what happens to those rows when Projects is uninstalled (orphan? null-out? preserve for reinstall?).

## Plan

### 1. Introduce an App Capability registry (frontend)

New module `src/lib/apps/capabilities.ts`:

- `type Capability = "projects.analytic-tagging" | "projects.task-linking" | "hr.employee-picker" | "inventory.stock-lookup" | ...` (string-literal union so TS enforces spelling).
- `CAPABILITY_PROVIDERS: Record<Capability, string /* appId */>` — declares which app provides each capability.
- Extend `AppDefinition` with `provides?: Capability[]`. Populate `PROJECTS_APP.provides = ["projects.analytic-tagging", "projects.task-linking"]`, `EMPLOYEES_APP.provides = ["hr.employee-picker"]`, etc. — audit every app.

New hook `src/hooks/useCapability.ts`:

```ts
export function useCapability(cap: Capability): { available: boolean; ready: boolean };
```

Implementation: reads `useInstalledApps()` + `useWorkspaceContextReady()`, returns `available` only when the providing app is installed AND workspace context is ready. Mirrors the readiness contract already documented in `useInstalledApps.ts`.

New component `src/components/apps/CapabilityGate.tsx`:

```tsx
<CapabilityGate cap="projects.analytic-tagging">
  <ProjectPicker ... />
</CapabilityGate>
```

Renders nothing (or an optional `fallback`) when the capability is not available. Uses `React.lazy` for the wrapped subtree so the provider app's bundle is **not** loaded when uninstalled.

### 2. Convert cross-app integration points

For each site currently doing a direct cross-app import, replace with a lazy `CapabilityGate`. Ordered by risk:

- Sales: `InvoiceCreatePage`, `InvoiceEditPage`, `SalesOrderCreatePage`, `SalesOrderEditPage` — wrap `ProjectPicker` and `LineAnalyticsCell` in `<CapabilityGate cap="projects.analytic-tagging">`. Convert `formData.project_id` writes to no-op when capability unavailable.
- Purchases: `BillCreatePage`, `BillEditPage`, `PurchaseOrderEditPage`, `ExpenseFormFields` — same treatment.
- Finance journal entry lines — same.
- POS → Inventory, HR sub-apps → Finance: audit and wrap.

Payload contract: when the capability is absent, the form submits with `project_id: null`. Downstream services (already null-tolerant on this column) keep working.

### 3. Backend capability enforcement

- New table `public.app_capability_registry(app_id text, capability text, primary key(app_id, capability))` seeded from the same list. `GRANT SELECT ... TO authenticated`. RLS: read-open, write via `service_role` only.
- New view `public.v_active_capabilities` = capabilities whose provider app is in `organization_installed_apps` for the caller's org.
- Extend `install_app` / `uninstall_app` RPCs: on uninstall, `NOTIFY capability_revoked` and clear a `capability_snapshot` JSONB column on `organization_installed_apps` used for offline first-paint.
- Add server-side guard in the write paths that touch cross-app columns (e.g. `invoices.project_id`): if the capability is not active for the org, reject the write with a typed error `E_CAPABILITY_UNAVAILABLE` rather than silently persisting a dangling FK.

### 4. Data hygiene on uninstall

`preview_uninstall_impact` RPC (extend the existing preview handler in `app-lifecycle`): for the app being uninstalled, count rows in every table that references it (e.g. `invoices.project_id`, `bills.project_id`, `journal_lines.project_id`, `expenses.project_id`, `timesheets.project_id`). Return the counts to the UI. The uninstall dialog shows: "12 invoices are tagged to projects — those tags will be preserved but hidden until Projects is reinstalled."

Policy (Odoo-aligned): **preserve** the FK values, but mask them at read time via `v_active_capabilities`. This means reinstalling Projects transparently restores the integration.

### 5. Lint + architecture tests

- New ESLint rule `eslint-rules/no-cross-app-import.js`: forbid `src/features/<A>/**` from importing `src/features/<B>/**` or `src/components/<B>/**` unless the import path is a `CapabilityGate` wrapper.
- New test `src/test/architecture/capability-gates.test.ts`: asserts every capability declared in the registry has (a) at least one provider app, (b) at least one gated consumer, (c) a matching entry in `MODULE_TO_APP_MAP` if it grants any RBAC surface.
- Extend `no-retired-apps.test.ts` sibling to also assert no retired app id appears in `CAPABILITY_PROVIDERS`.

### 6. Rollout

1. Land capability registry + hook + gate (no behaviour change).
2. Wrap Sales/Purchases/Finance ProjectPicker/TaskPicker/LineAnalyticsCell sites (fixes the reported bug).
3. Ship `preview_uninstall_impact` extension + uninstall dialog copy.
4. Add server-side `E_CAPABILITY_UNAVAILABLE` guard on the FK write paths.
5. Turn on the ESLint rule + architecture test. Fix remaining violations discovered by the rule.

### Technical details

- Capability strings are namespaced by provider app id (`projects.*`, `hr.*`) so ownership is unambiguous.
- `useCapability` composes with `useWorkspaceContextReady` — during hydration, `available` is `false` **and** `ready` is `false`, so `CapabilityGate` renders `null` (or a skeleton) instead of flashing the field.
- Because `CapabilityGate` uses `React.lazy`, uninstalling Projects also stops pulling `useProjects` and its query cache into Sales/Purchases bundles at runtime.
- No new migration is needed for the ProjectPicker fix itself — step 2 is pure frontend. Steps 3–4 add migrations and the RPC extensions.
- No user data is destroyed at any step; uninstall becomes fully reversible.

### Non-goals

- Not touching the RBAC `MODULE_TO_APP_MAP` semantics — that layer stays as-is.
- Not migrating retired apps.
- Not renaming existing FKs like `invoices.project_id`.

