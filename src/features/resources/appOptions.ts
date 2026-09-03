/**
 * Shared taxonomy for the Resource Center.
 *
 * `app_key` values are stable strings that match tenant app IDs where
 * applicable, plus `"getting-started"` for platform-wide onboarding and
 * `"platform"` for cross-cutting product tours. The list is kept flat and
 * hand-curated (rather than derived from the app registry) so platform
 * admins get a predictable dropdown even when an app isn't installed on
 * the current tenant.
 */
export interface ResourceAppOption {
  key: string;
  label: string;
}

export const RESOURCE_APP_OPTIONS: ResourceAppOption[] = [
  { key: "getting-started", label: "Getting started" },
  { key: "dashboard", label: "Dashboard" },
  { key: "finance", label: "Finance" },
  { key: "sales", label: "Sales" },
  { key: "purchases", label: "Purchases" },
  { key: "inventory", label: "Inventory" },
  { key: "pos", label: "Point of Sale" },
  { key: "payroll", label: "Payroll" },
  { key: "projects", label: "Projects" },
  { key: "crm", label: "CRM" },
  { key: "reports", label: "Reports" },
  { key: "platform", label: "Platform & Settings" },
];

export function labelForAppKey(key: string | null | undefined): string {
  if (!key) return "General";
  return RESOURCE_APP_OPTIONS.find((o) => o.key === key)?.label ?? key;
}

export const DIFFICULTY_OPTIONS = [
  { value: "intro", label: "Intro" },
  { value: "deep-dive", label: "Deep dive" },
] as const;

export const AUDIENCE_OPTIONS = [
  { value: "public", label: "Public (visible on /demo)" },
  { value: "authenticated", label: "Signed-in users only" },
] as const;
