---
name: Scope switcher placement (ADR 2026-08-28)
description: Scope switcher lives in the WorkspaceTopBar chip (ScopeSwitcherChip), never in the profile menu; gated by membership via useCanSwitchScope, not by admin role.
type: feature
---

# Scope switcher placement

- Canonical trigger: `src/components/common/ScopeSwitcherChip.tsx`, mounted in
  `WorkspaceTopBar` right after the breadcrumb. Present on every PlatformShell page.
- Label prefers page-declared scope (`useDeclareScope`), falls back to live
  `BusinessContext` / `BranchContext` so it is never blank.
- Never put the scope switcher in the profile/avatar menu: identity ≠ data context
  (Odoo / NetSuite / Dynamics / Xero all keep them separate).
- Visibility is a **membership** question, not a privilege one. Gate only on
  `useCanSwitchScope().shouldShowTrigger` (≥2 workspaces/companies/branches, or
  server-authorised consolidated with ≥2 branches). Do NOT add an admin-only gate.
- Exactly one trigger per screen: `ScopeBadge` suppresses its inline
  "Change scope" button when `useAppLayout().isInsideAppLayout` is true.
  Legacy `AppSidebar` / `AppAwareSidebar` keep `SidebarContextSwitcher` (no topbar there).
- Guarded by `src/test/architecture/scope-switcher-topbar.test.ts`.
