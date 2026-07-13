/**
 * @deprecated Import from `@/apps/platform-admin/nav` instead. This file
 * remains as a backward-compat shim while call sites migrate; it just
 * re-exports the canonical `PLATFORM_ADMIN_NAV` under the previous
 * `ADMIN_NAV` / `AdminNavItem` / `AdminNavGroup` names.
 */
import {
  PLATFORM_ADMIN_NAV,
  findAdminCrumb as _findAdminCrumb,
  type AdminWorkspaceNavItem,
  type AdminWorkspaceNavGroup,
} from "@/apps/platform-admin/nav";

export type AdminNavItem = AdminWorkspaceNavItem;
export type AdminNavGroup = AdminWorkspaceNavGroup;

export const ADMIN_NAV: AdminWorkspaceNavGroup[] = PLATFORM_ADMIN_NAV.groups;

export const findAdminCrumb = _findAdminCrumb;
