/**
 * Workspace navigation types for the new PlatformShell.
 *
 * A WorkspaceNav is the contract each app supplies so the
 * WorkspaceSidebar can render a stable, grouped, scalable
 * left-nav (Operations / Insights / Setup) instead of the legacy
 * horizontal tab strip + per-page SubNav stack.
 */
import type { LucideIcon } from "lucide-react";
import type { Permission } from "@/lib/permissions";

export interface WorkspaceNavItem {
  /**
   * Absolute route, e.g. "/hr/employees". Optional: a grouping node that only
   * holds `children` (e.g. a report family) has no route of its own.
   */
  to?: string;
  label: string;
  icon?: LucideIcon;
  /** Match exactly (e.g. directory root). Defaults to false. */
  end?: boolean;
  /** Optional badge text. */
  badge?: string;
  /** Permission required to see this item. */
  permission?: Permission;
  /** Nested items, rendered as a collapsible sub-tree. */
  children?: WorkspaceNavItem[];
}

export interface WorkspaceNavGroup {
  /** UPPERCASE short label, e.g. "Operations". */
  label: string;
  items: WorkspaceNavItem[];
}

export interface WorkspaceNav {
  groups: WorkspaceNavGroup[];
}
