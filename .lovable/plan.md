## Verification of prior state

I audited the prior agent's exit claim and confirm the following on disk:

- **Phase 0–6** substrate present (`src/apps/platform-admin/`, `eslint-rules/no-dialog-crud-in-admin.js`, four-pattern primitives consumed by all migrated admin pages).
- **Prior `.lovable/plan.md` items 1–4** are shipped: `OrganizationPeekSheet.tsx`, `AdminAppCatalogEditPage.tsx`, `FeaturePeekSheet.tsx`, and the email-templates `?templatePreview=` peek all exist and are wired in.
- **Phase 7.1** is shipped exactly as claimed: `src/apps/platform-admin/nav.ts` exports `PLATFORM_ADMIN_NAV: AdminWorkspaceNav`, and `PlatformAdminAppLayout` threads a `nav` prop through `AdminDashboardLayout` → `AdminSidebar` / `AdminSidebarBody` / `AdminTopBar`, mirroring `PlatformShell(app, nav, children)`.
- Remaining `platform-admin.md` slices: **Phase 7.2** (visual shell alignment) and **Phase 7.3** (page-group opt-in). This plan covers 7.2 only, so the shell change is landed and validated on one page-group before we begin the app-wide opt-in in 7.3.

## Goal (Phase 7.2)

Admin pages currently render inside `AdminDashboardLayout`. Tenant apps render inside `PlatformShell`. The two are structurally close but not identical — sidebar, topbar, mobile Sheet, spacing tokens and behavior all diverge in small ways. The brief's core criterion ("admin must feel like part of the same ERP") requires that admin adopt the same visual shell primitive tenant apps use — minus the pieces that don't apply to a persona (AppRail, install gate, subscription/access gate, active-business requirement).

Extract that shared body so both shells consume it, then route `PlatformAdminAppLayout` through it. No admin page code changes in this phase; the seam is the existing `nav` prop plumbed in 7.1.

## Approach

### 1. Extract `WorkspaceShellFrame` from `PlatformShell`

New file: `src/components/layout/shell/WorkspaceShellFrame.tsx`.

Owns the pure layout body currently inside `PlatformShellBody`:

- outer `flex min-h-screen w-full bg-background` container
- desktop sidebar slot
- mobile nav `Sheet`
- topbar slot
- main content area with `max-w-6xl` cap, padding, and `useFullWidthRequested()` override
- banner slots (subscription/trial) as optional children so admin can pass none

Props:

```ts
interface WorkspaceShellFrameProps {
  sidebar: ReactNode;              // desktop sidebar
  mobileSidebar: ReactNode;        // rendered inside Sheet
  topBar: ReactNode;
  banners?: ReactNode;             // above <main>, optional
  children: ReactNode;
  fullWidth?: boolean;
  noPadding?: boolean;
  mobileNavOpen: boolean;
  onMobileNavOpenChange: (v: boolean) => void;
}
```

The frame is presentation-only — no data hooks, no gates. That keeps admin (persona) and tenant (app) sharing the exact same chrome while each keeps its own gating in its wrapper.

### 2. Refactor `PlatformShell` to use the frame

`PlatformShellBody` becomes a thin composition:

- keeps all existing hooks (`useSession`, `useAppNavigation`, `useInstalledApps`, `useWorkspaceContextReady`, `useRequireActiveBusiness`) exactly where they are
- keeps the not-installed / no-access early returns unchanged
- renders `<WorkspaceShellFrame sidebar={<WorkspaceSidebar/>} mobileSidebar={<MobileAppSwitcher/> + <SidebarBody/>} topBar={<WorkspaceTopBar/>} banners={<SubscriptionStatusBanner/><SubscriptionReadOnlyBanner/><AppTrialBanner/>}>`

Zero behavior change for tenant apps. Verified by build + a Playwright pass on one tenant app route (`/sales`).

### 3. Rebuild `PlatformAdminAppLayout` on the frame

Replace the current `AdminDashboardLayout` delegation with a direct composition of `WorkspaceShellFrame`, wired to the admin sidebar/topbar primitives already refactored to take a `nav` prop in 7.1:

```tsx
<CountryWorkspaceProvider>
  <WorkspaceShellFrame
    sidebar={<AdminSidebar nav={nav} />}
    mobileSidebar={<AdminSidebarBody nav={nav} onNavigate={closeMobileNav} />}
    topBar={<AdminTopBar nav={nav} onOpenMobileNav={openMobileNav} />}
    mobileNavOpen={mobileNavOpen}
    onMobileNavOpenChange={setMobileNavOpen}
  >
    {children}
  </WorkspaceShellFrame>
</CountryWorkspaceProvider>
```

No banners for admin (persona has no subscription/trial concept). No `AppLayoutProvider` for admin unless a downstream primitive requires it — audit this by grepping `useFullWidthRequested` / `useRequestFullWidth` inside `src/pages/admin/**` and `src/components/admin/**`. If any admin page already uses it, wrap admin in `AppLayoutProvider appId="platform-admin"` to keep the same seam.

### 4. Deprecate `AdminDashboardLayout`

- Convert `src/components/admin/AdminDashboardLayout.tsx` into a thin backward-compat wrapper that re-exports `PlatformAdminAppLayout` under the old name, with a JSDoc `@deprecated` pointing to `PlatformAdminAppLayout`. The three remaining direct consumers (`AdminProfile.tsx`, `AdminLayoutRoute.tsx`, `AdminInlineMfaSetup.tsx`) keep working with no code change.
- Route migration off the deprecated name is deferred to Phase 7.3 (per-page-group).

### 5. Update the audit doc

Mark Phase 7.2 as shipped in `docs/design-system/audit/platform-admin.md`. Update Phase 7.3 to reference `WorkspaceShellFrame` as the target primitive and confirm the opt-in sequence: Organizations & Users → Plans/Apps/Features → Localization → Email/Demo/Team/Groups → Settings/Infra/Audit.

## Verification

- `bun run build:dev` clean.
- `bun run lint` clean, including `no-dialog-crud-in-admin`.
- Playwright smoke: (a) tenant app `/sales` renders identically (visual diff against pre-change screenshot), (b) admin `/admin-management` renders inside the new shared frame with the sidebar, topbar, mobile Sheet, and content max-width visually consistent with tenant apps.
- Grep confirms no admin page imports `AdminDashboardLayout` directly except the three known consumers; each still mounts because the deprecated name re-exports the new layout.

## Non-goals (this plan)

- No changes to any tenant module or its shell behavior.
- No admin page code changes — the seam is the `nav` prop plumbed in 7.1 plus the frame swap in the layout wrapper.
- Phase 7.3 (page-group opt-in and retiring the deprecated `AdminDashboardLayout` name) is a follow-up plan, sliced per the sequence in the audit doc.
- No schema, RLS, or edge-function changes.

## Deliverables

- New: `src/components/layout/shell/WorkspaceShellFrame.tsx`.
- Edits: `PlatformShell.tsx` (recompose on frame), `PlatformAdminAppLayout.tsx` (compose on frame directly), `AdminDashboardLayout.tsx` (thin deprecated re-export), `docs/design-system/audit/platform-admin.md` (mark 7.2 shipped, update 7.3 target).

## Follow-up (separate plan)

Phase 7.3 — page-group opt-in. Migrate `/admin-management/*` off the deprecated `AdminDashboardLayout` name onto `PlatformAdminAppLayout` in the sequence above, retire `AdminDashboardLayout.tsx` at the end.
