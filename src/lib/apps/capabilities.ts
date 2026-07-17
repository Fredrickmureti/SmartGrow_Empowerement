/**
 * App Capability Registry
 *
 * The single source of truth for cross-app integration points.
 *
 * Background: modules used to embed each other via direct ES imports
 * (e.g. Sales invoicing imported `<ProjectPicker>` from the Projects
 * feature). When the providing app was uninstalled, the consumer kept
 * the widget mounted because the import graph doesn't know about
 * install state. Users saw fields like "Project" on a Sales Invoice
 * asking them to pick a value even though Projects was gone and no
 * projects existed.
 *
 * Fix: consuming code no longer talks to provider apps directly. It
 * asks for a *capability* (a named, versioned integration contract)
 * via `useCapability(cap)` / `<CapabilityGate cap={cap}>`. The
 * capability is only "available" when the providing app is installed
 * for the current organization AND workspace readiness is authoritative.
 *
 * This mirrors Odoo's glue-module pattern (`sale_project`,
 * `account_analytic`), Dynamics 365 solution feature flags, SAP BAdIs,
 * and NetSuite SuiteApp hooks: consumers depend on a *capability name*,
 * not on the provider module directly.
 *
 * Adding a capability:
 *   1. Add its literal to the `Capability` union below.
 *   2. Add its `appId` to `CAPABILITY_PROVIDERS`.
 *   3. Wrap consuming code in `<CapabilityGate cap="...">` or gate
 *      its render path with `useCapability("...").available`.
 *
 * Retiring a capability: leave the union entry with a `// retired`
 * marker so existing gates keep type-checking, and drop the entry
 * from `CAPABILITY_PROVIDERS` so it resolves as permanently
 * unavailable. This matches the retired-apps pattern in
 * `docs/architecture/APP_LIFECYCLE.md`.
 */

/**
 * Namespaced capability identifiers. Namespace = providing app id, so
 * ownership is unambiguous by inspection.
 */
export type Capability =
  /** Tagging a source document (invoice, bill, PO, expense, JE line, timesheet)
   *  to a project for analytic reporting and profitability. */
  | "projects.analytic-tagging"
  /** Linking a document line to a specific project task. */
  | "projects.task-linking";

/**
 * Which app must be installed for the capability to be considered active.
 */
export const CAPABILITY_PROVIDERS: Record<Capability, string> = {
  "projects.analytic-tagging": "projects",
  "projects.task-linking": "projects",
};

/**
 * Reverse lookup: capabilities a given app provides. Useful for the
 * uninstall-impact preview.
 */
export function getCapabilitiesProvidedBy(appId: string): Capability[] {
  return (Object.entries(CAPABILITY_PROVIDERS) as [Capability, string][])
    .filter(([, provider]) => provider === appId)
    .map(([cap]) => cap);
}
