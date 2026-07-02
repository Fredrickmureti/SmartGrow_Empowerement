/**
 * HR Domain Module
 *
 * The HR domain is split into 5 Odoo-aligned, independently installable apps:
 *   - Employees   (foundation, no dependencies)
 *   - Time Off    (depends on Employees)
 *   - Attendances (depends on Employees)
 *   - Timesheets  (depends on Employees)
 *   - Payroll     (depends on Employees + Finance)
 *   - Recruitment (depends on Employees, coming soon)
 *
 * The single export here is the URL-space dispatcher that mounts each
 * sub-app under `/hr/*` with its own AppInstalledGate and AppShell.
 *
 * The legacy `HRLayout` component (a URL-segment sniffer for the
 * pre-split monolith) has been removed. Each sub-app now owns its
 * own shell via `HrAppShell` in `./shared/AppShell.tsx`.
 */

export { HRApp, default } from "./routes";
