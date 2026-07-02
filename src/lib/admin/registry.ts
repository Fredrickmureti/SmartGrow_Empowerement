/**
 * Platform Admin Registry
 *
 * Single source of truth for navigable pages inside the global
 * platform-admin console (`/admin-management/*`). Mirrors how
 * `APP_REGISTRY` works for tenant apps but stays in its own file
 * so tenant-side code (sidebar, app switcher, install gates) is
 * NEVER polluted with admin-only entries.
 *
 * The ONLY consumer is `src/lib/command/buildPlatformAdminIndex.ts`,
 * which converts these definitions into `CommandEntry` objects with
 * `surface: "platform"` and `internalOnly: true`.
 *
 * To add a new admin page to Ctrl+K, add it here. Do NOT hard-code
 * entries in the command index builder.
 */

import {
  Building2,
  Users,
  Receipt,
  BarChart3,
  FileBarChart,
  Settings as SettingsIcon,
  Mail,
  Megaphone,
  Globe,
  ServerCog,
  Layers,
  AppWindow,
  CreditCard,
  ScrollText,
  UserCog,
  ShieldCheck,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

export interface PlatformAdminEntryDef {
  /** Stable id, e.g. "organizations". */
  id: string;
  /** Human label shown in the palette. */
  name: string;
  /** Short description; powers fuzzy + token matching. */
  description: string;
  /** Full route under `/admin-management/*`. */
  path: string;
  /** Icon rendered next to the title. */
  icon: LucideIcon;
  /** Lowercase aliases for matching (e.g. "tenants" for "organizations"). */
  keywords?: string[];
  /** Static priority (0–100). Higher = ranked higher all-else equal. */
  weight?: number;
}

export const PLATFORM_ADMIN_BASE = "/admin-management";

/**
 * Mirrors the routes registered under `/admin-management/*` in App.tsx.
 * Keep IDs stable — they end up in the command index and in usage logs.
 */
export const PLATFORM_ADMIN_REGISTRY: PlatformAdminEntryDef[] = [
  {
    id: "dashboard",
    name: "Admin Dashboard",
    description: "Overview of the entire platform",
    path: "",
    icon: LayoutDashboard,
    keywords: ["home", "overview", "platform"],
    weight: 80,
  },
  {
    id: "organizations",
    name: "Organizations",
    description: "All tenant workspaces on the platform",
    path: "/organizations",
    icon: Building2,
    keywords: ["tenants", "orgs", "workspaces", "customers", "accounts"],
    weight: 78,
  },
  {
    id: "users",
    name: "Users",
    description: "All end-users across every tenant",
    path: "/users",
    icon: Users,
    keywords: ["accounts", "people", "members"],
    weight: 76,
  },
  {
    id: "invoices",
    name: "Platform Invoices",
    description: "Billing invoices issued to tenants",
    path: "/invoices",
    icon: Receipt,
    keywords: ["billing", "subscription invoices"],
    weight: 70,
  },
  {
    id: "payments",
    name: "Payments",
    description: "Tenant subscription payments and gateways",
    path: "/payments",
    icon: CreditCard,
    keywords: ["billing", "stripe", "mpesa", "paypal", "providers"],
    weight: 70,
  },
  {
    id: "analytics",
    name: "Platform Analytics",
    description: "Usage, growth, and revenue analytics",
    path: "/analytics",
    icon: BarChart3,
    keywords: ["metrics", "kpi", "growth", "mrr", "arr", "churn"],
    weight: 72,
  },
  {
    id: "reports",
    name: "Platform Reports",
    description: "Aggregate reports across all tenants",
    path: "/reports",
    icon: FileBarChart,
    keywords: ["financials", "platform-wide"],
    weight: 68,
  },
  {
    id: "plan-builder",
    name: "Plan Builder",
    description: "Subscription plans, features, and entitlements",
    path: "/plan-builder",
    icon: Layers,
    keywords: ["plans", "tiers", "pricing", "subscriptions", "entitlements"],
    weight: 74,
  },
  {
    id: "app-catalog",
    name: "App Catalog",
    description: "Apps available to tenants and their gating",
    path: "/app-catalog",
    icon: AppWindow,
    keywords: ["apps", "modules", "marketplace", "platform apps"],
    weight: 72,
  },
  {
    id: "localization-packs",
    name: "Localization Packs",
    description: "Country presets, taxes, currencies, locales",
    path: "/localization-packs",
    icon: Globe,
    keywords: ["country", "i18n", "translations", "locale", "presets"],
    weight: 60,
  },
  {
    id: "email-center",
    name: "Email Center",
    description: "Platform email templates and automations",
    path: "/email-center",
    icon: Mail,
    keywords: ["templates", "smtp", "transactional"],
    weight: 64,
  },
  {
    id: "demo-requests",
    name: "Demo Requests",
    description: "Inbound demo / sales requests",
    path: "/demo-requests",
    icon: Megaphone,
    keywords: ["leads", "sales", "inbound"],
    weight: 58,
  },
  {
    id: "infrastructure",
    name: "Infrastructure",
    description: "Platform infra, queues, jobs, health",
    path: "/infrastructure",
    icon: ServerCog,
    keywords: ["health", "ops", "system", "monitoring"],
    weight: 60,
  },
  {
    id: "team",
    name: "Platform Team",
    description: "Platform admin members and roles",
    path: "/team",
    icon: UserCog,
    keywords: ["staff", "admins", "operators"],
    weight: 66,
  },
  {
    id: "groups",
    name: "Platform Groups",
    description: "Permission groups for platform admins",
    path: "/groups",
    icon: ShieldCheck,
    keywords: ["roles", "permissions", "rbac"],
    weight: 62,
  },
  {
    id: "audit-log",
    name: "Audit Log",
    description: "Platform-wide audit trail",
    path: "/audit-log",
    icon: ScrollText,
    keywords: ["logs", "history", "trail", "compliance"],
    weight: 64,
  },
  {
    id: "settings",
    name: "Platform Settings",
    description: "Global platform configuration",
    path: "/settings",
    icon: SettingsIcon,
    keywords: ["config", "preferences", "global"],
    weight: 56,
  },
];
