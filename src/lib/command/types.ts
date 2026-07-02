/**
 * Command Palette — Core Types
 *
 * Single schema describing every navigable or actionable thing in the app:
 * apps (modules), pages, create-actions, reports, and (future) records.
 *
 * Entries are produced by `buildStaticIndex()` from existing registries
 * — never authored by hand here, never duplicated per surface.
 */

import type { LucideIcon } from "lucide-react";
import type { Permission } from "@/lib/permissions";

export type CommandKind = "module" | "page" | "action" | "report" | "record";

/**
 * Which workspace surface an entry belongs to.
 *
 *  - "tenant"   : tenant workspace only (Sales, Finance, HR, …). Default.
 *  - "platform" : global platform-admin console (/admin-management/*).
 *  - "any"      : visible everywhere (e.g. "Open Settings", "Sign out").
 *
 * Surface is filtered by the *route the user is currently on*, not the
 * role they hold — a platform admin operating inside a tenant workspace
 * acts as a tenant user there. See `src/lib/command/surface.ts`.
 */
export type CommandSurface = "tenant" | "platform" | "any";

/** Context passed to `run()` handlers. Keep this minimal & serialisable-ish. */
export interface CommandRunContext {
  navigate: (to: string) => void;
  closePalette: () => void;
  currentAppId: string | null;
}

export interface CommandEntry {
  /** Stable id, e.g. "page:finance/invoices" or "action:create-invoice". */
  id: string;
  kind: CommandKind;
  title: string;
  /** Breadcrumb-style hint, e.g. "Finance › Invoices". */
  subtitle?: string;
  description?: string;
  /** Owning app id — used for context boost. "platform" for global. */
  appId: string;
  icon: LucideIcon;
  /** Lowercase tokens, including aliases / legacy paths. */
  keywords: string[];
  /** Static priority (0–100). Higher = more important. */
  weight?: number;

  // ── Gating (AND-combined; all optional) ──────────────────────────────
  permission?: Permission;
  /** Entitlement key → useSession.hasEntitlement. */
  feature?: string;
  /** Settings-level feature flag (e.g. "restaurant_mode"). */
  featureFlag?: string;
  /** App must be installed. */
  appInstall?: string;
  /** Hidden for portal users. */
  internalOnly?: boolean;
  /**
   * Workspace surface this entry belongs to. Defaults to "tenant" for
   * backward-compat — every existing entry stays where it was.
   */
  surface?: CommandSurface;

  // ── Behavior — exactly one of `to` | `run` ───────────────────────────
  /** Navigate to this route via react-router. */
  to?: string;
  /** Imperative handler (used for actions like "Create Invoice"). */
  run?: (ctx: CommandRunContext) => void | Promise<void>;
}

/** A scored entry produced by the ranking engine. */
export interface RankedEntry {
  entry: CommandEntry;
  score: number;
}

/** Local recency/frequency record for usage-based ranking. */
export interface UsageRecord {
  /** Number of times the entry was selected. */
  count: number;
  /** Last selection timestamp (ms since epoch). */
  lastUsedAt: number;
}

export type UsageMap = Record<string, UsageRecord>;
