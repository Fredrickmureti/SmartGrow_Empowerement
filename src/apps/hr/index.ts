/**
 * HR Domain Module
 *
 * Scoped to a single installable app for the microfinance platform:
 *   - Employees (staff directory, departments, positions, locations)
 *
 * No other HR sub-app is part of the product scope.
 *
 * The single export here is the URL-space dispatcher that mounts each
 * sub-app under `/hr/*` with its own AppInstalledGate and AppShell.
 *
 * The legacy `HRLayout` component (a URL-segment sniffer for the
 * pre-split monolith) has been removed. Each sub-app now owns its
 * own shell via `HrAppShell` in `./shared/AppShell.tsx`.
 */

export { HRApp, default } from "./routes";
