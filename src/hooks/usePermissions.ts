import { useMemo } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useSession } from "@/contexts/SessionContext";
import { 
  Permission, 
  hasPermission, 
  hasAnyPermission, 
  hasAllPermissions,
  canManageRole,
  getAssignableRoles,
  isRoleHigherOrEqual,
  resolveEffectivePermissions,
  PermissionGroupRule,
  AppRole 
} from "@/lib/permissions";

export function usePermissions() {
  const { userRole } = useOrganization();
  const role = userRole?.role;

  // Get dynamic group rules from session
  let groupRules: PermissionGroupRule[] = [];
  try {
    const session = useSession();
    const currentOrg = session.currentOrg;
    if (currentOrg?.permission_group_rules && currentOrg.permission_group_rules.length > 0) {
      groupRules = currentOrg.permission_group_rules as PermissionGroupRule[];
    }
  } catch {
    // SessionContext may not be available in all render trees
  }

  // Single resolution path. `resolveEffectivePermissions` owns the base-role
  // literals, the lending matrix (kept out of those literals) and the
  // admin/owner/super_admin full-access rule, then layers access-group rules on
  // top. Falling back to raw ROLE_PERMISSIONS here used to drop every lending
  // permission for users without access groups — which locked the owner out of
  // the Lending app.
  const effectivePerms = useMemo(
    () => resolveEffectivePermissions(role, groupRules),
    [role, groupRules],
  );


  const checkPerm = (permission: Permission): boolean => {
    return effectivePerms[permission] ?? false;
  };

  const checkAny = (perms: Permission[]): boolean => {
    return perms.some(p => checkPerm(p));
  };

  const checkAll = (perms: Permission[]): boolean => {
    return perms.every(p => checkPerm(p));
  };

  const permissions = useMemo(() => ({
    // Check single permission
    can: checkPerm,

    // Check if user has any of the permissions
    canAny: checkAny,

    // Check if user has all permissions
    canAll: checkAll,

    // Check if user can manage a specific role
    canManage: (targetRole: AppRole): boolean => {
      return canManageRole(role, targetRole);
    },

    // Get roles the user can assign
    assignableRoles: getAssignableRoles(role),

    // Check if user's role is higher or equal to another
    isHigherOrEqual: (targetRole: AppRole): boolean => {
      if (!role) return false;
      return isRoleHigherOrEqual(role, targetRole);
    },

    // Current role
    role,

    // Common permission checks (now use dynamic resolution)
    canManageTeam: checkPerm("manageTeam"),
    canEditSettings: checkPerm("editSettings"),
    canManageBusiness: checkPerm("manageBusiness"),
    canManageOrganization: checkPerm("manageOrganization"),
    canManageTaxSettings: checkPerm("manageTaxSettings"),
    canManageCurrency: checkPerm("manageCurrency"),
    canManagePaymentGateways: checkPerm("managePaymentGateways"),
    canManageEmailSettings: checkPerm("manageEmailSettings"),
    canViewFinancials: checkPerm("viewFinancials"),
    canManageFinancials: checkPerm("manageFinancials"),
    canViewReports: checkPerm("viewReports"),
    canViewContacts: checkPerm("viewContacts"),
    canManageContacts: checkPerm("manageContacts"),
    canViewProducts: checkPerm("viewProducts"),
    canManageProducts: checkPerm("manageProducts"),
    canViewSales: checkPerm("viewSales"),
    canManageSales: checkPerm("manageSales"),
    canViewPurchases: checkPerm("viewPurchases"),
    canManagePurchases: checkPerm("managePurchases"),
    canViewAuditLogs: checkPerm("viewAuditLogs"),
    
    // Payroll permission checks — granular SoD (Segregation of Duties)
    // `canManagePayroll` is SETUP-ONLY (templates, mappings, rules). Action surfaces
    // MUST gate on the specific granular flag below, not on canManagePayroll.
    canViewPayroll: checkPerm("viewPayroll"),
    canManagePayroll: checkPerm("managePayroll"),
    canRunPayroll: checkPerm("runPayroll"),
    canApprovePayroll: checkPerm("approvePayroll"),
    canPostPayrollGL: checkPerm("postPayrollGL"),
    canPayPayroll: checkPerm("payPayroll"),
    // Granular batch lifecycle aliases — no separate permission keys yet; closing
    // a batch reuses post-GL authority (same financial impact) and reversal reuses
    // pay authority (treasury authorises the offsetting cash movement). These can
    // be promoted to first-class permissions later without touching call sites.
    canClosePayroll: checkPerm("postPayrollGL"),
    canReversePayroll: checkPerm("postPayrollGL"),
    canExportPayroll: checkPerm("exportPayroll"),
    canViewSalaryDetails: checkPerm("viewSalaryDetails"),
    
    // POS permission checks
    canViewPOS: checkPerm("viewPOS"),
    canManagePOS: checkPerm("managePOS"),
    canProcessSales: checkPerm("processSales"),
    canProcessReturns: checkPerm("processReturns"),
    canVoidTransactions: checkPerm("voidTransactions"),
    canManageShifts: checkPerm("manageShifts"),
    canManageCashDrawer: checkPerm("manageCashDrawer"),
    canApplyDiscounts: checkPerm("applyDiscounts"),
    canViewPOSReports: checkPerm("viewPOSReports"),
    
    // Role check helper
    isViewer: role === "viewer",
    isPortal: role === "portal",
    
    // Directory permission
    canViewDirectory: checkPerm("viewDirectory"),
    
    // Sign permissions
    canViewSign: checkPerm("viewSign"),
    canManageSign: checkPerm("manageSign"),
    canDeleteSign: checkPerm("deleteSign"),
    
    // App management (admin-only, Odoo-aligned)
    canManageApps: checkPerm("manageApps"),
  }), [role, effectivePerms]);

  return permissions;
}
