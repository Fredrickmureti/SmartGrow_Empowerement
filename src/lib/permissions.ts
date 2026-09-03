import { Database } from "@/integrations/supabase/types";

export type AppRole = Database["public"]["Enums"]["app_role"];

// Define all permissions in the system
export type Permission = 
  | "manageTeam"           // Invite/remove members, edit roles
  | "editSettings"         // Edit organization settings (general)
  | "manageBusiness"       // Create/edit/delete businesses & branches
  | "manageOrganization"   // Edit organization core settings
  | "manageTaxSettings"    // Edit tax rates
  | "manageCurrency"       // Edit currency settings
  | "managePaymentGateways" // Configure payment integrations
  | "manageEmailSettings"  // Configure email settings
  | "viewFinancials"       // View financial data (accounts, journal entries, banking)
  | "manageFinancials"     // Create/edit financial records
  | "viewReports"          // View reports
  | "viewContacts"         // View contacts
  | "manageContacts"       // Create/edit contacts
  | "viewProducts"         // View products and inventory
  | "manageProducts"       // Create/edit products
  | "viewSales"            // View invoices, estimates, orders
  | "manageSales"          // Create/edit invoices, estimates, orders
  | "viewPurchases"        // View bills, expenses, purchase orders
  | "managePurchases"      // Create/edit bills, expenses, purchase orders
  | "viewAuditLogs"        // View audit logs
  // POS Permissions
  | "viewPOS"              // Access POS module
  | "managePOS"            // Configure POS settings (registers, discounts)
  | "processSales"         // Create POS transactions
  | "processReturns"       // Handle POS returns/refunds
  | "voidTransactions"     // Void completed POS sales
  | "manageShifts"         // Open/close POS shifts
  | "manageCashDrawer"     // Cash in/out operations
  | "applyDiscounts"       // Apply manual discounts in POS
  | "viewPOSReports"       // View POS analytics and reports
  // ERP Permissions - Leave Management (Time Off app)
  | "viewLeave"            // Access leave module (self-service)
  | "manageLeaveTypes"     // Configure leave types and policies
  | "approveLeave"         // Approve/reject leave requests (manager/HR — first level)
  | "approveLeaveLevel2"   // Grant final (second-level) approval on leave requests that require it
  | "viewTeamLeave"        // View team leave calendar and requests
  // ERP Permissions - Timesheets (Attendance app)
  | "viewTimesheets"       // Access timesheets module (self-service)
  | "approveTimesheets"    // Approve/reject timesheets (manager)
  | "viewTeamTimesheets"   // View team timesheet summaries
  // ERP Permissions - Attendance (Attendance app)
  | "viewAttendance"       // View attendance records (HR/manager)
  | "manageAttendance"     // Edit/correct attendance records
  | "manageWorkSchedule"   // Configure working hours and schedules
  // ERP Permissions - Projects
  | "viewProjects"         // View projects and tasks
  | "manageProjects"       // Create/edit projects, assign team
  | "logTime"              // Log time against tasks
  | "manageProjectFinancials"  // View/edit project costs, revenues, profitability; bill timesheets/milestones
  | "approveProjectTimesheets" // Approve timesheets logged on projects
  | "manageProjectConfig"      // Edit project templates, stages, billing rules
  // ERP Permissions - HR/Employee (Employees app)
  | "viewDirectory"        // View lightweight employee directory (name, photo, dept, title only)
  | "viewEmployees"        // Full employee admin access (HR Officer/Admin only)
  | "manageEmployees"      // Create/edit employee records, link users
  | "manageEmployeeDocuments" // Upload/manage employee files
  | "manageDepartments"    // Create/edit departments
  // Employees app — privacy & catalog (Stage 5)
  | "viewEmployeePrivate"  // Private info: address, ID numbers, emergency contact, marital, DOB
  | "viewEmployeePayroll"  // Salary, allowances, bank details on the employee record (≠ payroll runs)
  | "manageJobPositions"   // CRUD job positions catalog
  | "manageWorkLocations"  // CRUD work locations catalog
  // ERP Permissions - Payroll app (sensitive — money & accounting)
  // Segregation of Duties: distinct keys for each lifecycle action so a single
  // user cannot run + approve + post + pay. `managePayroll` is RETAINED as a
  // setup-only umbrella (mappings, settings, templates) — it MUST NOT be used
  // as an action gate on its own. Action surfaces should check the specific
  // granular key (`runPayroll`, `approvePayroll`, `postPayrollGL`, `payPayroll`).
  | "viewPayroll"          // View payroll runs, payslips (catalog only)
  | "managePayroll"        // Configure payroll settings/templates (NOT an action gate)
  | "runPayroll"           // Create/compute/discard a draft payroll run (clerk)
  | "approvePayroll"       // Approve a computed payroll run (manager)
  | "postPayrollGL"        // Post approved payroll to General Ledger (accounting)
  | "payPayroll"           // Create + disburse payment batches (treasury)
  | "viewSalaryDetails"    // See actual money amounts on payslips/reports (vs. metadata only)
  | "manageStatutoryRules" // Edit statutory tax/pension rules
  | "manageSalaryStructures" // Edit salary structures and components
  | "manageEmployeeLoans"  // Issue/manage employee loans and advances
  | "viewRemittances"      // View statutory remittance reports
  | "manageRemittances"    // Mark remittances paid, generate filings
  // ERP Permissions - Recruitment app (placeholder)
  | "viewRecruitment"      // View jobs and applicants
  | "manageRecruitment"    // Edit jobs and pipeline
  | "manageApplicants"     // Edit applicant records, hire to employee
  // Self-Service (auto-granted when employees.user_id = auth.uid())
  | "viewMyPayslip"
  | "viewMyLeave"
  | "viewMyAttendance"
  | "viewMyTimesheet"
  // Sign Module
  | "viewSign"             // View signature requests
  | "manageSign"           // Create/edit/send signature requests
  | "deleteSign"           // Delete signature requests (restricted)
  // System Administration
  | "manageApps"           // Install/uninstall apps, access marketplace (admin-only, Odoo-aligned)
  // Maker-checker / SOX-style separation (group-only — no base role grants these)
  | "postJournalEntry"     // Post draft JE → posted (separate from create/edit)
  | "exportFinancials"     // Export GL / financial reports
  | "exportPayroll"        // Export payroll registers / bank files
  | "exportSales"          // Export sales / AR data
  | "exportPurchases"      // Export purchase / AP data
  // Microfinance lending domain (see LENDING_ROLE_PERMISSIONS for the role matrix)
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

/**
 * Base-role lending matrix. Roles absent from this map get lending access only
 * through Access Groups (module: "lending").
 */
export const LENDING_ROLE_PERMISSIONS: Partial<Record<AppRole, LendingPermission[]>> = {
  branch_manager: [
    "viewClients", "manageClients", "viewLoanProducts",
    "viewApplications", "manageApplications", "approveApplications",
    "viewLoans", "manageLoans", "disburseLoans",
    "recordRepayments", "viewCollections", "manageCollections",
    "viewLendingReports",
  ],
  credit_officer: [
    "viewClients", "manageClients", "viewLoanProducts",
    "viewApplications", "manageApplications", "approveApplications",
    "viewLoans", "viewCollections", "viewLendingReports",
  ],
  loan_officer: [
    "viewClients", "manageClients", "viewLoanProducts",
    "viewApplications", "manageApplications",
    "viewLoans", "recordRepayments", "viewCollections",
    "viewLendingReports",
  ],
  collections_officer: [
    "viewClients", "viewLoans", "recordRepayments",
    "viewCollections", "manageCollections", "viewLendingReports",
  ],
  auditor: [
    "viewClients", "viewLoanProducts", "viewApplications",
    "viewLoans", "viewCollections", "viewLendingReports",
  ],
};

// Role hierarchy (higher number = more permissions)
// Legacy roles (accountant, staff, cashier, viewer) are kept for backward compat
// but new invitations use 'internal' + access groups
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

// Define permissions for each role.
// The five new SOX-style permissions (postJournalEntry, exportFinancials,
// exportPayroll, exportSales, exportPurchases) are GROUP-ONLY by design —
// no base role grants them, so they're allowed to be omitted from the literal
// objects below. Admin / owner / super_admin still get them via the resolver
// (admins always pass `user_has_module_permission`).
const NEVER_BY_BASE_ROLE = ["postJournalEntry", "exportFinancials", "exportPayroll", "exportSales", "exportPurchases"] as const;
type GroupOnlyPermission = typeof NEVER_BY_BASE_ROLE[number];
type RolePermissionMap = Record<Exclude<Permission, GroupOnlyPermission | LendingPermission>, boolean>
  & Partial<Record<GroupOnlyPermission | LendingPermission, boolean>>;

// Single source of truth for "internal-class" roles.
// `internal`, `accountant`, `staff`, `cashier`, `viewer` all resolve through
// the same minimal map — their effective permissions come from Access Groups
// (see resolveEffectivePermissions). Hand-maintained legacy matrices were
// dropped in the 2026-04 settings audit to eliminate drift; the legacy enum
// values are kept only for backward-compatibility with existing user_roles
// rows. New invitations use 'admin' or 'internal' (see getAssignableRoles).
const INTERNAL_BASE_PERMISSIONS: RolePermissionMap = {
  manageTeam: false,
  editSettings: false,
  manageBusiness: false,
  manageOrganization: false,
  manageTaxSettings: false,
  manageCurrency: false,
  managePaymentGateways: false,
  manageEmailSettings: false,
  viewFinancials: false,
  manageFinancials: false,
  viewReports: false,
  viewContacts: false,
  manageContacts: false,
  viewProducts: false,
  manageProducts: false,
  viewSales: false,
  manageSales: false,
  viewPurchases: false,
  managePurchases: false,
  viewAuditLogs: false,
  viewPOS: false,
  managePOS: false,
  processSales: false,
  processReturns: false,
  voidTransactions: false,
  manageShifts: false,
  manageCashDrawer: false,
  applyDiscounts: false,
  viewPOSReports: false,
  viewLeave: true,
  manageLeaveTypes: false,
  approveLeave: false,
  approveLeaveLevel2: false,
  viewTeamLeave: false,
  viewTimesheets: true,
  approveTimesheets: false,
  viewTeamTimesheets: false,
  viewProjects: false,
  manageProjects: false,
  logTime: true,
  viewDirectory: true,
  manageProjectFinancials: false,
  approveProjectTimesheets: false,
  manageProjectConfig: false,
  viewEmployees: false,
  manageEmployees: false,
  manageDepartments: false,
  viewEmployeePrivate: false,
  viewEmployeePayroll: false,
  manageJobPositions: false,
  manageWorkLocations: false,
  viewPayroll: false,
  managePayroll: false,
  viewSign: false,
  manageSign: false,
  deleteSign: false,
  manageApps: false,
  viewAttendance: false,
  manageAttendance: false,
  manageWorkSchedule: false,
  manageEmployeeDocuments: false,
  runPayroll: false,
  approvePayroll: false,
  postPayrollGL: false,
  payPayroll: false,
  viewSalaryDetails: false,
  manageStatutoryRules: false,
  manageSalaryStructures: false,
  manageEmployeeLoans: false,
  viewRemittances: false,
  manageRemittances: false,
  viewRecruitment: false,
  manageRecruitment: false,
  manageApplicants: false,
  // Self-service — granted to anyone with employee record
  viewMyPayslip: true,
  viewMyLeave: true,
  viewMyAttendance: true,
  viewMyTimesheet: true,
};

export const ROLE_PERMISSIONS: Record<AppRole, RolePermissionMap> = {
  super_admin: {
    manageTeam: true,
    editSettings: true,
    manageBusiness: true,
    manageOrganization: true,
    manageTaxSettings: true,
    manageCurrency: true,
    managePaymentGateways: true,
    manageEmailSettings: true,
    viewFinancials: true,
    manageFinancials: true,
    viewReports: true,
    viewContacts: true,
    manageContacts: true,
    viewProducts: true,
    manageProducts: true,
    viewSales: true,
    manageSales: true,
    viewPurchases: true,
    managePurchases: true,
    viewAuditLogs: true,
    // POS Permissions
    viewPOS: true,
    managePOS: true,
    processSales: true,
    processReturns: true,
    voidTransactions: true,
    manageShifts: true,
    manageCashDrawer: true,
    applyDiscounts: true,
    viewPOSReports: true,
    // ERP Permissions - Leave
    viewLeave: true,
    manageLeaveTypes: true,
    approveLeave: true,
    approveLeaveLevel2: true,
    viewTeamLeave: true,
    // ERP Permissions - Timesheets
    viewTimesheets: true,
    approveTimesheets: true,
    viewTeamTimesheets: true,
    // ERP Permissions - Projects
    viewProjects: true,
    manageProjects: true,
    logTime: true,
    manageProjectFinancials: true,
    approveProjectTimesheets: true,
    manageProjectConfig: true,
    // ERP Permissions - HR
    viewDirectory: true,
    viewEmployees: true,
    manageEmployees: true,
    manageDepartments: true,
    viewEmployeePrivate: true,
    viewEmployeePayroll: true,
    manageJobPositions: true,
    manageWorkLocations: true,
    viewPayroll: true,
    managePayroll: true,
    viewSign: true,
    manageSign: true,
    deleteSign: true,
    manageApps: true,
    // Attendance app
    viewAttendance: true,
    manageAttendance: true,
    manageWorkSchedule: true,
    // Employees app additions
    manageEmployeeDocuments: true,
    // Payroll app — fine-grained
    runPayroll: true,
    approvePayroll: true,
  viewSalaryDetails: true,
    postPayrollGL: true,
    payPayroll: true,
    manageStatutoryRules: true,
    manageSalaryStructures: true,
    manageEmployeeLoans: true,
    viewRemittances: true,
    manageRemittances: true,
    // Recruitment app
    viewRecruitment: true,
    manageRecruitment: true,
    manageApplicants: true,
    // Self-service
    viewMyPayslip: true,
    viewMyLeave: true,
    viewMyAttendance: true,
    viewMyTimesheet: true,
  },
  owner: {
    manageTeam: true,
    editSettings: true,
    manageBusiness: true,
    manageOrganization: true,
    manageTaxSettings: true,
    manageCurrency: true,
    managePaymentGateways: true,
    manageEmailSettings: true,
    viewFinancials: true,
    manageFinancials: true,
    viewReports: true,
    viewContacts: true,
    manageContacts: true,
    viewProducts: true,
    manageProducts: true,
    viewSales: true,
    manageSales: true,
    viewPurchases: true,
    managePurchases: true,
    viewAuditLogs: true,
    // POS Permissions
    viewPOS: true,
    managePOS: true,
    processSales: true,
    processReturns: true,
    voidTransactions: true,
    manageShifts: true,
    manageCashDrawer: true,
    applyDiscounts: true,
    viewPOSReports: true,
    // ERP Permissions - Leave
    viewLeave: true,
    manageLeaveTypes: true,
    approveLeave: true,
    approveLeaveLevel2: true,
    viewTeamLeave: true,
    // ERP Permissions - Timesheets
    viewTimesheets: true,
    approveTimesheets: true,
    viewTeamTimesheets: true,
    // ERP Permissions - Projects
    viewProjects: true,
    manageProjects: true,
    logTime: true,
    manageProjectFinancials: true,
    approveProjectTimesheets: true,
    manageProjectConfig: true,
    // ERP Permissions - HR
    viewDirectory: true,
    viewEmployees: true,
    manageEmployees: true,
    manageDepartments: true,
    viewEmployeePrivate: true,
    viewEmployeePayroll: true,
    manageJobPositions: true,
    manageWorkLocations: true,
    viewPayroll: true,
    managePayroll: true,
    viewSign: true,
    manageSign: true,
    deleteSign: true,
    manageApps: true,
    // Attendance app
    viewAttendance: true,
    manageAttendance: true,
    manageWorkSchedule: true,
    // Employees app additions
    manageEmployeeDocuments: true,
    // Payroll app — fine-grained
    runPayroll: true,
  viewSalaryDetails: true,
    approvePayroll: true,
    postPayrollGL: true,
    payPayroll: true,
    manageStatutoryRules: true,
    manageSalaryStructures: true,
    manageEmployeeLoans: true,
    viewRemittances: true,
    manageRemittances: true,
    // Recruitment app
    viewRecruitment: true,
    manageRecruitment: true,
    manageApplicants: true,
    // Self-service
    viewMyPayslip: true,
    viewMyLeave: true,
    viewMyAttendance: true,
    viewMyTimesheet: true,
  },
  admin: {
    manageTeam: true,
    editSettings: true,
    manageBusiness: true,
    manageOrganization: true,
    manageTaxSettings: true,
    manageCurrency: true,
    managePaymentGateways: true,
    manageEmailSettings: true,
    viewFinancials: true,
    manageFinancials: true,
    viewReports: true,
    viewContacts: true,
    manageContacts: true,
    viewProducts: true,
    manageProducts: true,
    viewSales: true,
    manageSales: true,
    viewPurchases: true,
    managePurchases: true,
    viewAuditLogs: true,
    // POS Permissions
    viewPOS: true,
    managePOS: true,
    processSales: true,
    processReturns: true,
    voidTransactions: true,
    manageShifts: true,
    manageCashDrawer: true,
    applyDiscounts: true,
    viewPOSReports: true,
    // ERP Permissions - Leave (Full HR access)
    viewLeave: true,
    manageLeaveTypes: true,
    approveLeave: true,
    approveLeaveLevel2: true,
    viewTeamLeave: true,
    // ERP Permissions - Timesheets
    viewTimesheets: true,
    approveTimesheets: true,
    viewTeamTimesheets: true,
    // ERP Permissions - Projects
    viewProjects: true,
    manageProjects: true,
    logTime: true,
    manageProjectFinancials: true,
    approveProjectTimesheets: true,
    manageProjectConfig: true,
    // ERP Permissions - HR
    viewDirectory: true,
    viewEmployees: true,
    manageEmployees: true,
    manageDepartments: true,
    viewEmployeePrivate: true,
    viewEmployeePayroll: true,
    manageJobPositions: true,
    manageWorkLocations: true,
    viewPayroll: true,
    managePayroll: true,
    viewSign: true,
    manageSign: true,
    deleteSign: true,
    manageApps: true,
    // Attendance app
    viewAttendance: true,
    manageAttendance: true,
    manageWorkSchedule: true,
    // Employees app additions
    manageEmployeeDocuments: true,
    // Payroll app — fine-grained
  viewSalaryDetails: true,
    runPayroll: true,
    approvePayroll: true,
    postPayrollGL: true,
    payPayroll: true,
    manageStatutoryRules: true,
    manageSalaryStructures: true,
    manageEmployeeLoans: true,
    viewRemittances: true,
    manageRemittances: true,
    // Recruitment app
    viewRecruitment: true,
    manageRecruitment: true,
    manageApplicants: true,
    // Self-service
    viewMyPayslip: true,
    viewMyLeave: true,
    viewMyAttendance: true,
    viewMyTimesheet: true,
  },
  // Legacy role — resolved through Access Groups (single source of truth).
  accountant: { ...INTERNAL_BASE_PERMISSIONS },
  // Legacy role — resolved through Access Groups (single source of truth).
  staff: { ...INTERNAL_BASE_PERMISSIONS },
  // Legacy role — resolved through Access Groups (single source of truth).
  viewer: { ...INTERNAL_BASE_PERMISSIONS },
  portal: {
    manageTeam: false,
    editSettings: false,
    manageBusiness: false,
    manageOrganization: false,
    manageTaxSettings: false,
    manageCurrency: false,
    managePaymentGateways: false,
    manageEmailSettings: false,
    viewFinancials: false,
    manageFinancials: false,
    viewReports: false,
    viewContacts: false,
    manageContacts: false,
    viewProducts: false,
    manageProducts: false,
    viewSales: false,
    manageSales: false,
    viewPurchases: false,
    managePurchases: false,
    viewAuditLogs: false,
    // POS Permissions - No access
    viewPOS: false,
    managePOS: false,
    processSales: false,
    processReturns: false,
    voidTransactions: false,
    manageShifts: false,
    manageCashDrawer: false,
    applyDiscounts: false,
    viewPOSReports: false,
    // Self-service only
    viewLeave: true,
    manageLeaveTypes: false,
    approveLeave: false,
    approveLeaveLevel2: false,
    viewTeamLeave: false,
    viewTimesheets: true,
    approveTimesheets: false,
    viewTeamTimesheets: false,
    viewProjects: false,
    manageProjects: false,
    logTime: true,
    manageProjectFinancials: false,
    approveProjectTimesheets: false,
    manageProjectConfig: false,
    viewDirectory: false,
    viewEmployees: false,
    manageEmployees: false,
    manageDepartments: false,
    viewEmployeePrivate: false,
    viewEmployeePayroll: false,
    manageJobPositions: false,
    manageWorkLocations: false,
    viewPayroll: false,
    managePayroll: false,
    viewSign: false,
    manageSign: false,
    deleteSign: false,
    manageApps: false,
    // Attendance app — no admin access
    viewAttendance: false,
    manageAttendance: false,
    manageWorkSchedule: false,
    // Employees app — no admin access
    manageEmployeeDocuments: false,
  viewSalaryDetails: false,
    // Payroll app — no admin access
    runPayroll: false,
    approvePayroll: false,
    postPayrollGL: false,
    payPayroll: false,
    manageStatutoryRules: false,
    manageSalaryStructures: false,
    manageEmployeeLoans: false,
    viewRemittances: false,
    manageRemittances: false,
    // Recruitment app — no access
    viewRecruitment: false,
    manageRecruitment: false,
    manageApplicants: false,
    // Self-service — portal users see their own data
    viewMyPayslip: true,
    viewMyLeave: true,
    viewMyAttendance: true,
    viewMyTimesheet: true,
  },
  // Legacy role — resolved through Access Groups (single source of truth).
  cashier: { ...INTERNAL_BASE_PERMISSIONS },
  // Internal user type — permissions come entirely from Access Groups.
  // This is a minimal fallback when no groups are assigned.
  internal: { ...INTERNAL_BASE_PERMISSIONS },
  branch_manager: { ...INTERNAL_BASE_PERMISSIONS },
  loan_officer: { ...INTERNAL_BASE_PERMISSIONS },
  credit_officer: { ...INTERNAL_BASE_PERMISSIONS },
  collections_officer: { ...INTERNAL_BASE_PERMISSIONS },
  auditor: { ...INTERNAL_BASE_PERMISSIONS },
};

// ============================================================
// Dynamic Permission Groups (Odoo-Style ACLs)
// ============================================================

/** Modules that can be assigned granular permissions */
/**
 * Permission modules — Odoo-aligned, one module per installable app.
 *
 * The HR domain is split into FIVE modules so Access Groups can govern each
 * sub-app independently:
 *   - employees    (foundation: directory, departments, contracts, documents)
 *   - leave        (Time Off app: requests, allocations, approvals)
 *   - attendance   (Attendance app: clock-in oversight, work schedules, timesheet approvals)
 *   - payroll      (Payroll app: runs, payslips, statutory rules, remittances)
 *   - recruitment  (Recruitment app: jobs, applicants, hiring)
 *
 * `hr` is RETAINED ONLY as a deprecated alias for back-compat with rows seeded
 * before the split. New rules MUST target `employees`. The resolver treats `hr`
 * and `employees` as equivalent.
 *
 * `timesheets` is also retained for back-compat — old rows targeted it for
 * attendance/timesheet permissions; new rules should target `attendance`.
 */
export const PERMISSION_MODULES = [
  "contacts",
  "products",
  "sales",
  "purchases",
  "financials",
  "employees",
  "leave",
  "attendance",
  "recruitment",
  "timesheets",  // deprecated alias for attendance — kept for back-compat
  "hr",          // deprecated alias for employees — kept for back-compat
  "projects",
  "payroll",
  "pos",
  "lending",
  "settings",
  "team",
] as const;

export type PermissionModule = typeof PERMISSION_MODULES[number];

export const MODULE_LABELS: Record<PermissionModule, string> = {
  contacts: "Contacts",
  products: "Products & Inventory",
  sales: "Sales",
  purchases: "Purchases",
  financials: "Financials & Reports",
  employees: "Employees",
  leave: "Time Off",
  attendance: "Attendance & Timesheets",
  recruitment: "Recruitment",
  timesheets: "Timesheets (legacy)",
  hr: "HR / Employees (legacy)",
  projects: "Projects",
  payroll: "Payroll",
  pos: "Point of Sale",
  lending: "Lending (Microfinance)",
  // sign: retired 2026-05-09
  settings: "Settings",
  team: "Team & Audit",
};

/**
 * Modules surfaced in the Access Groups admin UI. Excludes deprecated aliases
 * (`hr`, `timesheets`) — those still resolve at runtime but are hidden from new
 * rule editors so admins are guided toward the per-app modules.
 */
export const ACTIVE_PERMISSION_MODULES: PermissionModule[] = [
  "contacts",
  "products",
  "sales",
  "purchases",
  "financials",
  "employees",
  "leave",
  "attendance",
  "recruitment",
  "projects",
  "payroll",
  "pos",
  "lending",
  // "sign" retired 2026-05-09
  "settings",
  "team",
];

/**
 * Maps module + operation to Permission keys.
 *
 * Operations:
 *   read/create/write/delete  — standard CRUD
 *   approve                   — maker-checker approval (timesheets, leave, JE, payroll)
 *   post                      — draft → posted (JE, payroll, invoices)
 *   pay                       — disburse cash (payroll payment batches, AP payments)
 *   export                    — sensitive data export (payroll, GL, sales/AP)
 *
 * Each array projects which Permission keys a `can_*` flag grants.
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
  contacts:   { read: ["viewContacts"],   create: ["manageContacts"],  write: ["manageContacts"],  delete: ["manageContacts"] },
  products:   { read: ["viewProducts"],   create: ["manageProducts"],  write: ["manageProducts"],  delete: ["manageProducts"] },
  sales:      { read: ["viewSales"],      create: ["manageSales"],     write: ["manageSales"],     delete: ["manageSales"], export: ["exportSales"] },
  purchases:  { read: ["viewPurchases"],  create: ["managePurchases"], write: ["managePurchases"], delete: ["managePurchases"], export: ["exportPurchases"] },
  financials: { read: ["viewFinancials", "viewReports"], create: ["manageFinancials"], write: ["manageFinancials"], delete: ["manageFinancials"], post: ["postJournalEntry"], export: ["exportFinancials"] },
  // Employees app — foundation HR data (departments, contracts, employee docs)
  employees:  { read: ["viewDirectory", "viewEmployees", "viewEmployeePrivate", "viewEmployeePayroll"], create: ["manageEmployees", "manageDepartments", "manageEmployeeDocuments", "manageJobPositions", "manageWorkLocations"], write: ["manageEmployees", "manageDepartments", "manageEmployeeDocuments", "manageJobPositions", "manageWorkLocations"], delete: ["manageEmployees", "manageJobPositions", "manageWorkLocations"], export: ["exportFinancials"] },
  // Time Off app
  leave:      { read: ["viewLeave", "viewTeamLeave"], create: ["manageLeaveTypes"], write: ["manageLeaveTypes"], delete: ["manageLeaveTypes"], approve: ["approveLeave"] },
  // Attendance app — clock-in oversight, work schedules, timesheet approvals
  attendance: { read: ["viewAttendance", "viewTimesheets", "viewTeamTimesheets"], create: ["manageAttendance", "manageWorkSchedule"], write: ["manageAttendance", "manageWorkSchedule"], delete: ["manageAttendance"], approve: ["approveTimesheets"] },
  // Recruitment app — placeholder permissions (full impl pending)
  recruitment:{ read: ["viewRecruitment"], create: ["manageRecruitment", "manageApplicants"], write: ["manageRecruitment", "manageApplicants"], delete: ["manageRecruitment"] },
  // Deprecated: `timesheets` resolves to the same set as `attendance`
  timesheets: { read: ["viewTimesheets", "viewTeamTimesheets", "viewAttendance"], create: ["manageAttendance", "manageWorkSchedule"], write: ["manageAttendance", "manageWorkSchedule"], delete: ["manageAttendance"], approve: ["approveTimesheets"] },
  // Deprecated: `hr` resolves to the same set as `employees`
  hr:         { read: ["viewDirectory", "viewEmployees", "viewEmployeePrivate", "viewEmployeePayroll"], create: ["manageEmployees", "manageDepartments", "manageEmployeeDocuments", "manageJobPositions", "manageWorkLocations"], write: ["manageEmployees", "manageDepartments", "manageEmployeeDocuments", "manageJobPositions", "manageWorkLocations"], delete: ["manageEmployees", "manageJobPositions", "manageWorkLocations"] },
  projects:   { read: ["viewProjects"],   create: ["manageProjects", "logTime"], write: ["manageProjects"], delete: ["manageProjects"], approve: ["manageProjects"] },
  // Payroll app — granular SoD: create/run, approve, post-GL, pay (disburse), export are SEPARATE.
  // `managePayroll` is intentionally kept as a setup-only key (templates, mappings) NOT mapped
  // into any granular operation here — action surfaces must check the specific granular permission.
  payroll:    { read: ["viewPayroll", "viewRemittances"], create: ["runPayroll", "manageEmployeeLoans"], write: ["managePayroll", "manageStatutoryRules", "manageSalaryStructures", "manageRemittances"], delete: ["runPayroll"], approve: ["approvePayroll"], post: ["postPayrollGL"], pay: ["payPayroll"], export: ["exportPayroll"] },
  pos:        { read: ["viewPOS", "viewPOSReports"], create: ["managePOS", "processSales", "manageShifts", "manageCashDrawer", "applyDiscounts"], write: ["managePOS", "processReturns", "voidTransactions"], delete: ["managePOS"] },
  lending:    {
    read:   ["viewClients", "viewLoanProducts", "viewApplications", "viewLoans", "viewCollections", "viewLendingReports"],
    create: ["manageClients", "manageApplications"],
    write:  ["manageClients", "manageApplications", "manageLoans", "manageCollections", "manageLoanProducts", "manageLendingConfig"],
    delete: ["manageClients", "manageLoanProducts"],
    approve:["approveApplications"],
    pay:    ["disburseLoans"],
    post:   ["recordRepayments"],
  },
  // sign: retired 2026-05-09
  settings:   { read: ["editSettings"],   create: ["manageBusiness", "manageOrganization", "manageTaxSettings", "manageCurrency", "managePaymentGateways", "manageEmailSettings"], write: ["manageBusiness", "manageOrganization", "manageTaxSettings"], delete: ["manageBusiness"] },
  team:       { read: ["viewAuditLogs"],  create: ["manageTeam"],      write: ["manageTeam"],      delete: ["manageTeam"] },
};

export interface PermissionGroupRule {
  module: PermissionModule;
  can_read: boolean;
  can_create: boolean;
  can_write: boolean;
  can_delete: boolean;
  /** Maker-checker: approve drafts (timesheets, leave, JE, payroll). Group-only. */
  can_approve?: boolean;
  /** Post draft → posted (JE, payroll runs). Group-only. */
  can_post?: boolean;
  /** Disburse cash (payroll payment batches, AP payments). Group-only. */
  can_pay?: boolean;
  /** Export sensitive data (payroll, GL, reports). Group-only. */
  can_export?: boolean;
}

/**
 * Internal roles whose permissions are defined by their Access Groups (Odoo-aligned).
 * When groups are assigned, permissions come DIRECTLY from the union of all group rules
 * — there is NO ceiling from the base role. This matches Odoo where "Internal User"
 * type users get permissions purely from their group memberships.
 * 
 * Without Access Groups, the base role permissions apply as default/fallback.
 * 
 * IMPORTANT: Portal is EXCLUDED because portal users have FIXED permissions
 * (leave, timesheets, profile) that admins cannot modify.
 * A database trigger (trg_prevent_portal_group_assignment) blocks group assignment
 * to portal users at the DB level as defense in depth.
 */
const INTERNAL_GROUP_ROLES: AppRole[] = ["internal", "viewer", "staff", "accountant", "cashier"];

/**
 * Modules that portal users are allowed to receive via Access Groups.
 * All other modules are INTERNAL-ONLY and cannot be granted to portal users.
 * This enforces Odoo's hard boundary: portal users never get business-level permissions.
 */
const PORTAL_ALLOWED_MODULES: PermissionModule[] = ["leave", "timesheets", "attendance"];

/**
 * Resolves effective permissions by combining base role with Access Group rules.
 * 
 * Odoo-aligned behavior:
 * - For internal users (staff, viewer, accountant, cashier) WITH groups assigned:
 *   Groups are PURELY ADDITIVE — the union of all group rules defines the user's
 *   permissions directly. No ceiling from the base role. This matches Odoo where
 *   internal users' permissions come entirely from their group memberships.
 * 
 * - When NO Access Groups are assigned: Base role permissions apply as-is (backward compatible).
 * 
 * - For admin/owner/super_admin: Always have full permissions (groups are a no-op).
 * 
 * - For portal users: Only leave/timesheets modules are allowed via groups (additive on base).
 */
export function resolveEffectivePermissions(
  baseRole: AppRole | undefined | null,
  groupRules: PermissionGroupRule[]
): Record<Permission, boolean> {
  const ALL_PERMISSIONS: Permission[] = [
    "manageTeam","editSettings","manageBusiness","manageOrganization","manageTaxSettings",
    "manageCurrency","managePaymentGateways","manageEmailSettings","viewFinancials",
    "manageFinancials","viewReports","viewContacts","manageContacts","viewProducts",
    "manageProducts","viewSales","manageSales","viewPurchases","managePurchases",
    "viewAuditLogs","viewPOS","managePOS","processSales","processReturns",
    "voidTransactions","manageShifts","manageCashDrawer","applyDiscounts","viewPOSReports",
    "viewLeave","manageLeaveTypes","approveLeave","approveLeaveLevel2","viewTeamLeave","viewTimesheets",
    "approveTimesheets","viewTeamTimesheets","viewAttendance","manageAttendance",
    "manageWorkSchedule","viewProjects","manageProjects","logTime","viewDirectory",
    "viewEmployees","manageEmployees","manageEmployeeDocuments","manageDepartments",
    "viewEmployeePrivate","viewEmployeePayroll","manageJobPositions","manageWorkLocations",
    "viewPayroll","managePayroll","runPayroll","approvePayroll","postPayrollGL","payPayroll",
    "manageStatutoryRules","manageSalaryStructures","manageEmployeeLoans",
    "viewRemittances","manageRemittances","viewRecruitment","manageRecruitment",
    "manageApplicants","viewMyPayslip","viewMyLeave","viewMyAttendance","viewMyTimesheet",
    "viewSign","manageSign","deleteSign","manageApps",
    "postJournalEntry","exportFinancials","exportPayroll","exportSales","exportPurchases",
    ...LENDING_PERMISSIONS,
  ];
  const baseRaw = baseRole ? (ROLE_PERMISSIONS[baseRole] as Record<string, boolean | undefined>) : null;
  const base: Record<Permission, boolean> = {} as Record<Permission, boolean>;
  for (const k of ALL_PERMISSIONS) base[k] = baseRaw ? Boolean(baseRaw[k]) : false;
  // Lending grants live in their own matrix (kept out of the legacy role literals).
  if (baseRole) for (const k of LENDING_ROLE_PERMISSIONS[baseRole] ?? []) base[k] = true;

  // Admin-like roles: full access including group-only permissions.
  if (baseRole === "admin" || baseRole === "owner" || baseRole === "super_admin") {
    const out: Record<Permission, boolean> = {} as Record<Permission, boolean>;
    for (const k of ALL_PERMISSIONS) out[k] = true;
    return out;
  }

  if (!groupRules || groupRules.length === 0) return base;

  const effectiveRules = baseRole === "portal"
    ? groupRules.filter(rule => PORTAL_ALLOWED_MODULES.includes(rule.module))
    : groupRules;

  const fromGroups: Record<Permission, boolean> = {} as Record<Permission, boolean>;
  for (const k of ALL_PERMISSIONS) fromGroups[k] = false;

  for (const rule of effectiveRules) {
    const mapping = MODULE_PERMISSION_MAP[rule.module];
    if (!mapping) continue;
    if (rule.can_read)              for (const p of mapping.read)              fromGroups[p] = true;
    if (rule.can_create)            for (const p of mapping.create)            fromGroups[p] = true;
    if (rule.can_write)             for (const p of mapping.write)             fromGroups[p] = true;
    if (rule.can_delete)            for (const p of mapping.delete)            fromGroups[p] = true;
    if (rule.can_approve && mapping.approve) for (const p of mapping.approve)  fromGroups[p] = true;
    if (rule.can_post    && mapping.post)    for (const p of mapping.post)     fromGroups[p] = true;
    if (rule.can_pay     && mapping.pay)     for (const p of mapping.pay)      fromGroups[p] = true;
    if (rule.can_export  && mapping.export)  for (const p of mapping.export)   fromGroups[p] = true;
  }

  const isInternalGroupRole = baseRole && INTERNAL_GROUP_ROLES.includes(baseRole);
  const isPortal = baseRole === "portal";
  const result: Record<Permission, boolean> = {} as Record<Permission, boolean>;

  for (const key of ALL_PERMISSIONS) {
    if (isInternalGroupRole) result[key] = fromGroups[key] === true;
    else if (isPortal)       result[key] = base[key] === true || fromGroups[key] === true;
    else                     result[key] = base[key] === true;
  }
  return result;
}

export function hasPermission(role: AppRole | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  const map = ROLE_PERMISSIONS[role] as Record<string, boolean | undefined> | undefined;
  return map?.[permission] === true;
}

// Check if a role has any of the specified permissions
export function hasAnyPermission(role: AppRole | undefined | null, permissions: Permission[]): boolean {
  if (!role) return false;
  return permissions.some(permission => hasPermission(role, permission));
}

// Check if a role has all of the specified permissions
export function hasAllPermissions(role: AppRole | undefined | null, permissions: Permission[]): boolean {
  if (!role) return false;
  return permissions.every(permission => hasPermission(role, permission));
}

// Compare two roles - returns true if role1 is higher or equal to role2
export function isRoleHigherOrEqual(role1: AppRole, role2: AppRole): boolean {
  return ROLE_HIERARCHY[role1] >= ROLE_HIERARCHY[role2];
}

// Check if a role can manage another role (for role editing)
export function canManageRole(managerRole: AppRole | undefined | null, targetRole: AppRole): boolean {
  if (!managerRole) return false;
  
  // Only owner can manage admins
  if (targetRole === "admin" && managerRole !== "owner" && managerRole !== "super_admin") {
    return false;
  }
  
  // No one can manage owners except super_admin
  if (targetRole === "owner" && managerRole !== "super_admin") {
    return false;
  }
  
  // No one can manage super_admin
  if (targetRole === "super_admin") {
    return false;
  }
  
  // Manager must have higher hierarchy
  return ROLE_HIERARCHY[managerRole] > ROLE_HIERARCHY[targetRole];
}

// Get roles that a manager can assign to others
export function getAssignableRoles(managerRole: AppRole | undefined | null): AppRole[] {
  if (!managerRole) return [];
  
  const assignable: AppRole[] = [];
  
  // Owner can assign admin and internal
  if (managerRole === "owner" || managerRole === "super_admin") {
    assignable.push("admin", "internal");
  }
  // Admin can assign internal
  else if (managerRole === "admin") {
    assignable.push("internal");
  }
  
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
  owner: "Full access to organization with ability to manage all team members",
  admin: "Full access with ability to manage non-admin team members",
  internal: "Access determined by assigned Access Groups",
  accountant: "Access determined by assigned Access Groups", // legacy
  staff: "Access determined by assigned Access Groups",      // legacy
  cashier: "Access determined by assigned Access Groups",    // legacy
  viewer: "Access determined by assigned Access Groups",     // legacy
  portal: "Self-service only — leave requests, timesheets, personal documents",
  branch_manager: "Branch operations oversight; access refined by Access Groups",
  loan_officer: "Owns a client portfolio; access refined by Access Groups",
  credit_officer: "Credit assessment and approval; access refined by Access Groups",
  collections_officer: "Arrears and collections follow-up; access refined by Access Groups",
  auditor: "Read-only review access; refined by Access Groups",
};
