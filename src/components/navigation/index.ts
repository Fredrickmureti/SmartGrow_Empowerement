/**
 * Navigation Components Module
 *
 * @deprecated All exports in this barrel are deprecated. Use the design
 * system instead:
 *
 *   import { WorkspaceShell, AppRail, WorkspaceSidebar } from "@/design-system";
 *
 * These wrappers continue to exist only so unmigrated legacy modules keep
 * rendering. New code MUST NOT import from here. See docs/design-system.md.
 *
 * Each component additionally logs a one-time runtime warning when mounted
 * to surface accidental imports in the browser console.
 */

export { AppSwitcher } from "./AppSwitcher";
/** @deprecated Use `WorkspaceHeader` from `@/design-system`. */
export { AppNavbar } from "./AppNavbar";
/** @deprecated Use `WorkspaceShell` from `@/design-system`. */
export { AppLayout, MobileAppNav } from "./AppLayout";
/** @deprecated Use `WorkspaceSidebar` from `@/design-system`. */
export { AppAwareSidebar } from "./AppAwareSidebar";
/** @deprecated Navigation mode is no longer toggleable — the design system has a single shell. */
export { NavigationModeToggle } from "./NavigationModeToggle";
