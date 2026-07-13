/**
 * AdminDashboardLayout — deprecated alias for `PlatformAdminAppLayout`.
 *
 * @deprecated Import `PlatformAdminAppLayout` from `@/apps/platform-admin`
 * instead. This re-export exists so the three remaining direct
 * consumers (AdminProfile, AdminLayoutRoute, AdminInlineMfaSetup)
 * keep working while Phase 7.3 migrates them.
 */
export { PlatformAdminAppLayout as AdminDashboardLayout } from "@/apps/platform-admin/PlatformAdminAppLayout";
