import { Database } from "@/integrations/supabase/types";

export type AppRole = Database["public"]["Enums"]["app_role"];

/**
 * Permission vocabulary — microfinance only.
 *
 * The inherited ERP permissions (products, sales, purchases, POS, HR, payroll,
 * leave, attendance, recruitment, e-sign) were deleted in the 2026-09
 * authorization reconstruction. They are not deprecated aliases — they no
 * longer exist anywhere in the app or in the Access Group catalogue.
 */
export type Permission =
  // Platform / administration
  | "manageTeam"           // Invite/remove members, edit roles
  | "editSettings"         // Edit organization settings (general)
  | "manageBusiness"       // Create/edit/delete institutions & branches
  | "manageOrganization"   // Edit organization core settings
  | "manageTaxSettings"    // Edit tax rates
  | "manageCurrency"       // Edit currency settings
  | "managePaymentGateways" // Configure payment integrations
  | "manageEmailSettings"  // Configure email settings
  | "manageApps"           // Install/uninstall apps (admin-only)
  | "viewAuditLogs"        // View audit logs
  // Contacts
  | "viewContacts"
  | "manageContacts"
  // Accounting / treasury / reporting
  | "viewFinancials"       // View accounts, journal entries, banking
  | "manageFinancials"     // Create/edit financial records
  | "viewReports"          // View reports
  // Maker-checker / SOX-style separation (group-only — no base role grants these)
  | "postJournalEntry"     // Post draft JE → posted (separate from create/edit)
  | "exportFinancials"     // Export GL / financial reports
  // Microfinance lending domain (grants come only from the user's access group)
  | LendingPermission;

/**
 * Lending (microfinance) permissions.
 *
 * These are UI/navigation gates only — the authoritative enforcement lives in
 * the database (RLS + officer/branch scoping) and in the server-side event
 * handlers. Adding one here never widens backend access.
 */
export type LendingPermission =
  | "viewClients"          // View client records and groups
  | "manageClients"        // Create/edit clients, groups, KYC documents
  | "viewLoanProducts"     // View loan product catalog
  | "manageLoanProducts"   // Create/edit loan products and pricing
  | "viewApplications"     // View loan applications and assessments
  | "manageApplications"   // Capture/edit applications and assessments
  | "approveApplications"  // Approve or decline applications (maker-checker)
  | "viewLoans"            // View loans, schedules, statements
  | "manageLoans"          // Restructure, top-up, write-off, close loans
  | "disburseLoans"        // Release approved loan funds
  | "recordRepayments"     // Record client repayments / receipts
  | "viewCollections"      // View arrears, PAR and collection sheets
  | "manageCollections"    // Run collection sheets, log follow-ups, promises
  | "viewLendingReports"   // Portfolio, arrears, collections, disbursement reports
  | "manageLendingConfig"; // Loan accounting mappings and lending settings

export const LENDING_PERMISSIONS: LendingPermission[] = [
  "viewClients", "manageClients",
  "viewLoanProducts", "manageLoanProducts",
  "viewApplications", "manageApplications", "approveApplications",
  "viewLoans", "manageLoans", "disburseLoans",
  "recordRepayments",
  "viewCollections", "manageCollections",
  "viewLendingReports",
  "manageLendingConfig",
];

/** Every permission key in the system, in one array. */
export const ALL_PERMISSIONS: Permission[] = [
  "manageTeam", "editSettings", "manageBusiness", "manageOrganization",
  "manageTaxSettings", "manageCurrency", "managePaymentGateways",
  "manageEmailSettings", "manageApps", "viewAuditLogs",
  "viewContacts", "manageContacts",
  "viewFinancials", "manageFinancials", "viewReports",
  "postJournalEntry", "exportFinancials",
  ...LENDING_PERMISSIONS,
];




// Role hierarchy (higher number = more permissions)
export const ROLE_HIERARCHY: Record<AppRole, number> = {
  super_admin: 100,
  owner: 90,
  admin: 70,
  internal: 30,
  accountant: 30, // legacy — same as internal
  staff: 30,      // legacy — same as internal
  cashier: 20,    // legacy — same as internal
  viewer: 10,     // legacy — same as internal
  portal: 5,
  branch_manager: 60,
  loan_officer: 30,
  credit_officer: 40,
  collections_officer: 30,
  auditor: 20,
};

export type RolePermissionMap = Partial<Record<Permission, boolean>>;

const allPermissions = (value: boolean): RolePermissionMap => {
  const map: RolePermissionMap = {};
  for (const key of ALL_PERMISSIONS) map[key] = value;
  return map;
};

// Internal-class roles resolve entirely through Access Groups.
const INTERNAL_BASE_PERMISSIONS: RolePermissionMap = allPermissions(false);
const FULL_ACCESS: RolePermissionMap = allPermissions(true);

export const ROLE_PERMISSIONS: Record<AppRole, RolePermissionMap> = {
  super_admin: { ...FULL_ACCESS },
  owner: { ...FULL_ACCESS },
  admin: { ...FULL_ACCESS },
  accountant: { ...INTERNAL_BASE_PERMISSIONS },
  staff: { ...INTERNAL_BASE_PERMISSIONS },
  viewer: { ...INTERNAL_BASE_PERMISSIONS },
  // Portal is retained only because the app_role enum still carries it; the
  // institution runs staff-only, so a portal user has no permissions at all.
  portal: { ...INTERNAL_BASE_PERMISSIONS },
  cashier: { ...INTERNAL_BASE_PERMISSIONS },
  internal: { ...INTERNAL_BASE_PERMISSIONS },
  branch_manager: { ...INTERNAL_BASE_PERMISSIONS },
  loan_officer: { ...INTERNAL_BASE_PERMISSIONS },
  credit_officer: { ...INTERNAL_BASE_PERMISSIONS },
  collections_officer: { ...INTERNAL_BASE_PERMISSIONS },
  auditor: { ...INTERNAL_BASE_PERMISSIONS },
};

// ============================================================
// Access Group modules (Odoo-style ACLs) — microfinance vocabulary
// ============================================================

export const PERMISSION_MODULES = [
  "clients",
  "loan_products",
  "applications",
  "loans",
  "repayments",
  "collections",
  "contacts",
  "accounting",
  "treasury",
  "reports",
  "branches",
  "audit",
  "settings",
  "team",
] as const;

export type PermissionModule = typeof PERMISSION_MODULES[number];

export const MODULE_LABELS: Record<PermissionModule, string> = {
  clients: "Clients",
  loan_products: "Loan Products",
  applications: "Loan Applications",
  loans: "Loans",
  repayments: "Repayments",
  collections: "Collections & Arrears",
  contacts: "Contacts",
  accounting: "Accounting",
  treasury: "Treasury & Banking",
  reports: "Reports",
  branches: "Branches",
  audit: "Audit Trail",
  settings: "Settings",
  team: "Team & Access",
};

/** Modules surfaced in the Access Groups admin UI (all of them). */
export const ACTIVE_PERMISSION_MODULES: PermissionModule[] = [...PERMISSION_MODULES];

/**
 * Maps module + operation to Permission keys.
 *
 * Operations:
 *   read/create/write/delete  — standard CRUD
 *   approve                   — maker-checker approval
 *   post                      — draft → posted / booked
 *   pay                       — release cash (disbursement, payments)
 *   export                    — sensitive data export
 */
const MODULE_PERMISSION_MAP: Record<PermissionModule, {
  read: Permission[];
  create: Permission[];
  write: Permission[];
  delete: Permission[];
  approve?: Permission[];
  post?: Permission[];
  pay?: Permission[];
  export?: Permission[];
}> = {
  clients: {
    read: ["viewClients"], create: ["manageClients"], write: ["manageClients"], delete: ["manageClients"],
    export: ["viewLendingReports"],
  },
  loan_products: {
    read: ["viewLoanProducts"], create: ["manageLoanProducts"],
    write: ["manageLoanProducts", "manageLendingConfig"], delete: ["manageLoanProducts"],
  },
  applications: {
    read: ["viewApplications"], create: ["manageApplications"], write: ["manageApplications"],
    delete: ["manageApplications"], approve: ["approveApplications"],
  },
  loans: {
    read: ["viewLoans"], create: ["manageLoans"], write: ["manageLoans"], delete: [],
    pay: ["disburseLoans"], export: ["viewLendingReports"],
  },
  repayments: {
    read: ["viewLoans"], create: ["recordRepayments"], write: ["recordRepayments"], delete: [],
    post: ["recordRepayments"], export: ["viewLendingReports"],
  },
  collections: {
    read: ["viewCollections"], create: ["manageCollections"], write: ["manageCollections"],
    delete: ["manageCollections"], export: ["viewLendingReports"],
  },
  contacts: {
    read: ["viewContacts"], create: ["manageContacts"], write: ["manageContacts"], delete: ["manageContacts"],
  },
  accounting: {
    read: ["viewFinancials"], create: ["manageFinancials"], write: ["manageFinancials"],
    delete: ["manageFinancials"], post: ["postJournalEntry"], export: ["exportFinancials"],
  },
  treasury: {
    read: ["viewFinancials"], create: ["manageFinancials"], write: ["manageFinancials"],
    delete: [], pay: ["disburseLoans"], export: ["exportFinancials"],
  },
  reports: {
    read: ["viewReports", "viewLendingReports"], create: [], write: [], delete: [],
    export: ["exportFinancials"],
  },
  branches: {
    read: ["viewFinancials"], create: ["manageBusiness"], write: ["manageBusiness"], delete: ["manageBusiness"],
  },
  audit: {
    read: ["viewAuditLogs"], create: [], write: [], delete: [], export: ["exportFinancials"],
  },
  settings: {
    read: ["editSettings"],
    create: ["manageBusiness", "manageOrganization", "manageTaxSettings", "manageCurrency", "managePaymentGateways", "manageEmailSettings", "manageApps"],
    write: ["manageBusiness", "manageOrganization", "manageTaxSettings", "manageLendingConfig"],
    delete: ["manageBusiness"],
  },
  team: {
    read: ["viewAuditLogs"], create: ["manageTeam"], write: ["manageTeam"], delete: ["manageTeam"],
  },
};

export interface PermissionGroupRule {
  module: PermissionModule;
  can_read: boolean;
  can_create: boolean;
  can_write: boolean;
  can_delete: boolean;
  /** Maker-checker: approve drafts. Group-only. */
  can_approve?: boolean;
  /** Post draft → posted / booked. Group-only. */
  can_post?: boolean;
  /** Release cash (disbursement, payments). Group-only. */
  can_pay?: boolean;
  /** Export sensitive data. Group-only. */
  can_export?: boolean;
  /** Close a period / batch. Group-only. */
  can_close?: boolean;
  /** Reverse a posted document. Group-only. */
  can_reverse?: boolean;
  /** Break-glass override. Group-only. */
  can_admin_override?: boolean;
}


/**
 * Resolves effective permissions from the user's Access Group rules.
 *
 * - admin / owner / super_admin: full access, groups are a no-op.
 * - portal: no permissions (staff-only institution).
 * - everyone else: exactly what their access group grants — nothing else.
 *   This mirrors `user_has_module_permission` in the database, which is the
 *   authority; the UI must never offer more than the backend allows.
 */
export function resolveEffectivePermissions(
  baseRole: AppRole | undefined | null,
  groupRules: PermissionGroupRule[]
): Record<Permission, boolean> {


  if (baseRole === "admin" || baseRole === "owner" || baseRole === "super_admin") {
    const out: Record<Permission, boolean> = {} as Record<Permission, boolean>;
    for (const k of ALL_PERMISSIONS) out[k] = true;
    return out;
  }

  if (baseRole === "portal") {
    const out: Record<Permission, boolean> = {} as Record<Permission, boolean>;
    for (const k of ALL_PERMISSIONS) out[k] = false;
    return out;
  }

  // Wave 1 (frontend half): the access group is the only authority for every
  // non-privileged role. The database `user_has_module_permission` dropped its
  // role matrix; keeping a role matrix here would let the UI offer actions the
  // backend refuses (and, worse, show applications the group never granted).
  // No group => no permissions, exactly as the database answers.
  const fromGroups: Record<Permission, boolean> = {} as Record<Permission, boolean>;
  for (const k of ALL_PERMISSIONS) fromGroups[k] = false;

  if (!groupRules || groupRules.length === 0) return fromGroups;

  for (const rule of groupRules) {
    const mapping = MODULE_PERMISSION_MAP[rule.module];
    if (!mapping) continue;
    if (rule.can_read)   for (const p of mapping.read)   fromGroups[p] = true;
    if (rule.can_create) for (const p of mapping.create) fromGroups[p] = true;
    if (rule.can_write)  for (const p of mapping.write)  fromGroups[p] = true;
    if (rule.can_delete) for (const p of mapping.delete) fromGroups[p] = true;
    if (rule.can_approve && mapping.approve) for (const p of mapping.approve) fromGroups[p] = true;
    if (rule.can_post    && mapping.post)    for (const p of mapping.post)    fromGroups[p] = true;
    if (rule.can_pay     && mapping.pay)     for (const p of mapping.pay)     fromGroups[p] = true;
    if (rule.can_export  && mapping.export)  for (const p of mapping.export)  fromGroups[p] = true;
  }

  return fromGroups;
}

export function hasPermission(role: AppRole | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  const map = ROLE_PERMISSIONS[role] as Record<string, boolean | undefined> | undefined;
  return map?.[permission] === true;
}

export function hasAnyPermission(role: AppRole | undefined | null, permissions: Permission[]): boolean {
  if (!role) return false;
  return permissions.some(permission => hasPermission(role, permission));
}

export function hasAllPermissions(role: AppRole | undefined | null, permissions: Permission[]): boolean {
  if (!role) return false;
  return permissions.every(permission => hasPermission(role, permission));
}

export function isRoleHigherOrEqual(role1: AppRole, role2: AppRole): boolean {
  return ROLE_HIERARCHY[role1] >= ROLE_HIERARCHY[role2];
}

export function canManageRole(managerRole: AppRole | undefined | null, targetRole: AppRole): boolean {
  if (!managerRole) return false;
  if (targetRole === "admin" && managerRole !== "owner" && managerRole !== "super_admin") return false;
  if (targetRole === "owner" && managerRole !== "super_admin") return false;
  if (targetRole === "super_admin") return false;
  return ROLE_HIERARCHY[managerRole] > ROLE_HIERARCHY[targetRole];
}

export function getAssignableRoles(managerRole: AppRole | undefined | null): AppRole[] {
  if (!managerRole) return [];
  const assignable: AppRole[] = [];
  if (managerRole === "owner" || managerRole === "super_admin") assignable.push("admin", "internal");
  else if (managerRole === "admin") assignable.push("internal");
  return assignable;
}

// Role labels for UI
export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  admin: "Admin",
  internal: "Internal User",
  accountant: "Internal User", // legacy
  staff: "Internal User",     // legacy
  cashier: "Internal User",   // legacy
  viewer: "Internal User",    // legacy
  portal: "Portal User",
  branch_manager: "Branch Manager",
  loan_officer: "Loan Officer",
  credit_officer: "Credit Officer",
  collections_officer: "Collections Officer",
  auditor: "Auditor",
};

// Role descriptions for UI
export const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  super_admin: "Full platform access with super admin privileges",
  owner: "Full access to the institution with ability to manage all team members",
  admin: "Full access with ability to manage non-admin team members",
  internal: "Access determined by assigned Access Groups",
  accountant: "Access determined by assigned Access Groups", // legacy
  staff: "Access determined by assigned Access Groups",      // legacy
  cashier: "Access determined by assigned Access Groups",    // legacy
  viewer: "Access determined by assigned Access Groups",     // legacy
  portal: "No system access — retained only for historical records",
  branch_manager: "Branch operations oversight; access refined by Access Groups",
  loan_officer: "Owns a client portfolio; access refined by Access Groups",
  credit_officer: "Credit assessment and approval; access refined by Access Groups",
  collections_officer: "Arrears and collections follow-up; access refined by Access Groups",
  auditor: "Read-only review access; refined by Access Groups",
};
