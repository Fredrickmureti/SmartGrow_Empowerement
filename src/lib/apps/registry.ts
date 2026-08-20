/**
 * App Registry
 * 
 * Central registry of all apps in the system, inspired by Odoo's modular architecture.
 * Each app is a self-contained domain with its own modules, permissions, and routes.
 */

import {
  PiggyBank,
  Receipt,
  ShoppingCart,
  Package,
  Monitor,
  Users,
  UserCheck,
  Building2,
  Briefcase,
  FolderKanban,
  Settings,
  BookOpen,
  FileText,
  Landmark,
  Target,
  Building,
  CalendarCheck,
  GitCompare,
  ListFilter,
  ClipboardList,
  Truck,
  RotateCcw,
  Wallet,
  FileCheck,
  CreditCard,
  Calculator,
  BarChart3,
  DollarSign,
  GraduationCap,
  Clock,
  CalendarOff,
  Warehouse,
  History,
  HandCoins,
  UserPlus,
  Wand2,
  Shield,
  FileBox,
  PenTool,
  FileSpreadsheet,
  LayoutGrid,
  LayoutDashboard,
  Bell,
  Sparkles,
  Inbox,
  ChefHat,
  Calendar,
  Tags,
  RefreshCw,
  MessageSquare,
  Zap,
  ScrollText,
  Ban,
  CalendarClock,
  MapPin,
  FileEdit,
  ShieldCheck,
  Cpu,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { AppDefinition, AppGroup, ModuleDefinition } from "./types";

/**
 * Finance App - Accounting, banking, and financial management
 */
export const FINANCE_APP: AppDefinition = {
  id: "finance",
  name: "Finance",
  description: "Accounting, banking, and financial reports",
  icon: PiggyBank,
  color: "hsl(142, 76%, 36%)", // Emerald green
  basePath: "/finance",
  requiredPlan: "starter",
  requiredPermissions: ["viewFinancials"],
  sortOrder: 1,
  defaultModule: "dashboard",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Dashboard", path: "/dashboard", icon: PiggyBank, permission: "viewFinancials" },
    { id: "receivables", name: "Accounts Receivable", path: "/receivables", icon: Wallet, permission: "viewFinancials" },
    { id: "payables", name: "Accounts Payable", path: "/payables", icon: CreditCard, permission: "viewFinancials" },
    { id: "customer-credits", name: "Customer Credits", path: "/customer-credits", icon: Wallet, permission: "viewFinancials" },
    { id: "statements", name: "Customer Statements", path: "/statements", icon: ScrollText, permission: "viewFinancials" },
    { id: "accounts", name: "Chart of Accounts", path: "/accounts", icon: BookOpen, permission: "viewFinancials" },
    { id: "journal-entries", name: "Journal Entries", path: "/journal-entries", icon: FileText, permission: "viewFinancials" },
    { id: "fiscal-periods", name: "Fiscal Periods", path: "/fiscal-periods", icon: CalendarCheck, permission: "viewFinancials" },
    { id: "budgets", name: "Budgets", path: "/budgets", icon: Target, permission: "viewFinancials" },
    { id: "fixed-assets", name: "Fixed Assets", path: "/fixed-assets", icon: Building, permission: "viewFinancials" },
    { id: "banking", name: "Banking", path: "/banking", icon: Landmark, permission: "viewFinancials" },
    { id: "bank-feeds", name: "Bank Feeds", path: "/bank-feeds", icon: ListFilter, permission: "viewFinancials" },
    { id: "reconciliation", name: "Reconciliation", path: "/reconciliation", icon: GitCompare, permission: "viewFinancials" },
    { id: "reports", name: "Financial Reports", path: "/reports", icon: BarChart3, permission: "viewReports" },
    { id: "settings", name: "Settings", path: "/settings", icon: FileText, permission: "viewFinancials" },
  ],
};

/**
 * Sales App - Customer invoicing, orders, and payments
 */
export const SALES_APP: AppDefinition = {
  id: "sales",
  name: "Sales",
  description: "Invoicing, quotes, orders, and customer payments",
  icon: Receipt,
  color: "hsl(217, 91%, 60%)", // Blue
  basePath: "/sales",
  requiredPlan: "starter",
  requiredPermissions: ["viewSales"],
  sortOrder: 2,
  defaultModule: "dashboard",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Dashboard", path: "/dashboard", icon: Receipt, permission: "viewSales" },
    { id: "invoices", name: "Invoices", path: "/invoices", icon: FileText, permission: "viewSales" },
    { id: "recurring", name: "Recurring Invoices", path: "/recurring", icon: Receipt, permission: "viewSales" },
    { id: "estimates", name: "Estimates", path: "/estimates", icon: FileText, permission: "viewSales" },
    { id: "proforma", name: "Proforma Invoices", path: "/proforma", icon: FileCheck, permission: "viewSales" },
    { id: "orders", name: "Sales Orders", path: "/orders", icon: ClipboardList, permission: "viewSales" },
    { id: "delivery-notes", name: "Delivery Notes", path: "/delivery-notes", icon: Truck, permission: "viewSales" },
    { id: "payments", name: "Customer Payments", path: "/payments", icon: Wallet, permission: "viewSales" },
    { id: "statements", name: "Customer Statements", path: "/statements", icon: FileText, permission: "viewSales" },
    { id: "collections", name: "Collections", path: "/collections", icon: HandCoins, permission: "viewSales" },
    { id: "returns", name: "Sales Returns", path: "/returns", icon: RotateCcw, permission: "viewSales" },
    { id: "credit-notes", name: "Credit Notes", path: "/credit-notes", icon: CreditCard, permission: "viewSales" },
    { id: "contacts", name: "Customers", path: "/customers", icon: Users, permission: "viewContacts" },
  ],
};

/**
 * Contacts App - Central hub for all contacts (Odoo-style)
 */
export const CONTACTS_APP: AppDefinition = {
  id: "contacts",
  name: "Contacts",
  description: "Manage customers, suppliers, and all contacts",
  icon: Users,
  color: "hsl(215, 65%, 50%)", // Slate blue
  basePath: "/contacts-app",
  requiredPlan: "starter",
  requiredPermissions: ["viewContacts"],
  sortOrder: 3,
  defaultModule: "all",
  internalOnly: true,
  modules: [
    { id: "all", name: "All Contacts", path: "", icon: Users, permission: "viewContacts" },
    { id: "customers", name: "Customers", path: "/customers", icon: UserCheck, permission: "viewContacts" },
    { id: "vendors", name: "Suppliers", path: "/vendors", icon: Building2, permission: "viewContacts" },
    { id: "companies", name: "Companies", path: "/companies", icon: Building, permission: "viewContacts" },
  ],
};

/**
 * Purchases App - Vendor bills, expenses, and purchase orders
 */
export const PURCHASES_APP: AppDefinition = {
  id: "purchases",
  name: "Purchases",
  description: "Bills, expenses, and supplier management",
  icon: ShoppingCart,
  color: "hsl(25, 95%, 53%)", // Orange
  basePath: "/purchases",
  requiredPlan: "starter",
  requiredPermissions: ["viewPurchases"],
  sortOrder: 4,
  defaultModule: "bills",
  internalOnly: true,
  modules: [
    { id: "bills", name: "Bills", path: "/bills", icon: Receipt, permission: "viewPurchases" },
    { id: "rfqs", name: "RFQs", path: "/rfqs", icon: FileText, permission: "viewPurchases", description: "Request for Quotation - compare vendor quotes" },
    { id: "purchase-orders", name: "Purchase Orders", path: "/orders", icon: ShoppingCart, permission: "viewPurchases" },
    { id: "expenses", name: "Expenses", path: "/expenses", icon: Receipt, permission: "viewPurchases" },
    { id: "returns", name: "Purchase Returns", path: "/returns", icon: RotateCcw, permission: "viewPurchases" },
    { id: "credit-notes", name: "Vendor Credits", path: "/credit-notes", icon: FileText, permission: "viewPurchases", description: "Vendor credit notes and debit notes" },
    { id: "price-lists", name: "Supplier Conditions", path: "/supplier-conditions", icon: Tags, permission: "viewPurchases", description: "Supplier prices, price breaks, purchase unit, minimum order quantity and lead times" },
    { id: "statements", name: "Vendor Statements", path: "/statements", icon: FileText, permission: "viewPurchases", description: "Generate and send AP statements to vendors" },
    { id: "aged-payables", name: "Aged Payables", path: "/aged-payables", icon: BarChart3, permission: "viewPurchases", description: "Outstanding payables aging report by vendor" },
    { id: "vendors", name: "Suppliers", path: "/vendors", icon: Users, permission: "viewContacts" },
  ],
};

/**
 * Inventory App - Products, stock, and warehouses
 */
export const INVENTORY_APP: AppDefinition = {
  id: "inventory",
  name: "Inventory",
  description: "Products, stock levels, and warehouse management",
  icon: Package,
  color: "hsl(262, 83%, 58%)", // Purple
  basePath: "/inventory-app",
  requiredPlan: "starter",
  requiredPermissions: ["viewProducts"],
  sortOrder: 5,
  defaultModule: "dashboard",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Dashboard", path: "/dashboard", icon: Package, permission: "viewProducts" },
    { id: "products", name: "Products", path: "/products", icon: Package, permission: "viewProducts" },
    { id: "stock", name: "Stock Levels", path: "/stock", icon: Package, permission: "viewProducts" },
    { id: "warehouses", name: "Warehouses", path: "/warehouses", icon: Warehouse, permission: "viewProducts" },
    { id: "replenishment", name: "Replenishment", path: "/replenishment", icon: RefreshCw, permission: "viewProducts", description: "Auto-generated purchase orders from reorder rules" },
    { id: "scrap", name: "Scrap / Waste", path: "/scrap", icon: Package, permission: "manageProducts" },
    { id: "count", name: "Physical Count", path: "/count", icon: Package, permission: "manageProducts" },
    { id: "uom", name: "Units of Measure", path: "/uom", icon: Package, permission: "manageProducts", description: "Define UoM categories and conversions" },
    { id: "reports", name: "Stock Reports", path: "/reports", icon: BarChart3, permission: "viewReports" },
  ],
};

/**
 * Warehouse App — physical-execution layer above Inventory (ADR 0079).
 *
 * Owns location, task, dock, appointment, wave, pick, pack, load. Never
 * owns stock quantity/value — Inventory stays canonical. Mounted at
 * `/warehouse-app/*` in src/App.tsx.
 */
export const WAREHOUSE_APP: AppDefinition = {
  id: "warehouse",
  name: "Warehouse",
  description: "Operator tasks, receiving, put-away, picking, packing, dispatch",
  icon: Warehouse,
  color: "hsl(24, 95%, 53%)", // Orange — distinct from Inventory purple
  basePath: "/warehouse-app",
  requiredPlan: "professional",
  requiredPermissions: ["viewProducts"],
  sortOrder: 5.5,
  defaultModule: "dashboard",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Overview", path: "/dashboard", icon: LayoutGrid, permission: "viewProducts" },
    { id: "warehouses", name: "Warehouses", path: "/warehouses", icon: Warehouse, permission: "viewProducts" },
    { id: "layout", name: "Layout", path: "/layout", icon: Warehouse, permission: "manageProducts", description: "Zones, aisles, racks, shelves, bins" },
    { id: "receiving", name: "Receiving", path: "/receiving", icon: Truck, permission: "viewProducts" },
    { id: "putaway", name: "Put-away", path: "/putaway", icon: Package, permission: "viewProducts" },
    { id: "tasks", name: "Operator tasks", path: "/tasks", icon: ClipboardList, permission: "viewProducts" },
    { id: "picking", name: "Picking", path: "/picking", icon: Package, permission: "viewProducts" },
    { id: "packing", name: "Packing", path: "/packing", icon: Package, permission: "viewProducts" },
    { id: "dispatch", name: "Dispatch", path: "/dispatch", icon: Truck, permission: "viewProducts" },
    { id: "qc", name: "Quality control", path: "/qc", icon: Shield, permission: "viewProducts" },
  ],
};

/**
 * POS App - Point of Sale operations
 * Note: Terminal requires a register ID parameter, so we link to the POS dashboard
 * which allows selecting a register before launching the terminal
 */
export const POS_APP: AppDefinition = {
  id: "pos",
  name: "Point of Sale",
  description: "Retail sales, terminal operations, and cash management",
  icon: Monitor,
  color: "hsl(346, 77%, 49%)", // Rose
  basePath: "/pos",
  requiredPlan: "professional",
  requiredPermissions: ["viewPOS"],
  sortOrder: 6,
  defaultModule: "dashboard",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "POS Dashboard", path: "", icon: Monitor, permission: "viewPOS" },
    // Restaurant mode modules - conditionally visible based on settings
    { id: "floor-plan", name: "Floor Plan", path: "/floor-plan", icon: LayoutGrid, permission: "viewPOS", featureFlag: "restaurant_mode", hidden: true },
    { id: "kitchen", name: "Kitchen Display", path: "/kitchen", icon: ChefHat, permission: "viewPOS", featureFlag: "kitchen_display", hidden: true },
    { id: "bookings", name: "Reservations", path: "/bookings", icon: Calendar, permission: "viewPOS", featureFlag: "table_bookings", hidden: true },
    { id: "reports", name: "POS Reports", path: "/reports", icon: BarChart3, permission: "viewPOSReports" },
    { id: "payment-terminals", name: "Payment Terminals", path: "/payment-terminals", icon: CreditCard, permission: "managePOS", description: "Configure Stripe Terminal, Adyen, Verifone, or Square credentials" },
    { id: "settings", name: "POS Settings", path: "/settings", icon: Settings, permission: "managePOS" },
  ],
};

/**
 * CRM App - Customer relationship management
 */
export const CRM_APP: AppDefinition = {
  id: "crm",
  name: "CRM",
  description: "Pipeline, leads, and customer activities",
  icon: Briefcase,
  color: "hsl(173, 80%, 40%)", // Teal
  basePath: "/crm-app",
  requiredPlan: "professional",
  requiredPermissions: ["viewContacts"],
  sortOrder: 7,
  defaultModule: "dashboard",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Dashboard", path: "/dashboard", icon: Briefcase, permission: "viewContacts" },
    { id: "pipeline", name: "Pipeline", path: "/pipeline", icon: Briefcase, permission: "viewContacts" },
    { id: "activities", name: "Activities", path: "/activities", icon: CalendarCheck, permission: "viewContacts" },
    { id: "contacts", name: "All Contacts", path: "/contacts", icon: Users, permission: "viewContacts" },
  ],
};

/**
 * Employees App — Foundational HR app (Odoo `hr` equivalent).
 *
 * Owns the employee record, departments, contracts, and people analytics.
 * Every other HR-domain app (Time Off, Attendance, Payroll, Recruitment)
 * depends on this app being installed first.
 *
 * Self-service surfaces (`my-portal`, `my-profile`, personal payslips/leave)
 * are NOT in this app — they live under `/me/*` (My Workspace) and are
 * available to any authenticated user linked to an `employees` row.
 */
export const EMPLOYEES_APP: AppDefinition = {
  id: "employees",
  name: "Employees",
  description: "Employee directory, departments, contracts, and people analytics",
  icon: Users,
  color: "hsl(45, 93%, 47%)", // Amber
  basePath: "/hr",
  requiredPlan: "professional",
  requiredPermissions: ["viewEmployees", "viewDirectory"],
  sortOrder: 8,
  defaultModule: "employees",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Dashboard", path: "/dashboard", icon: Users, permission: "viewEmployees" },
    { id: "employees", name: "Employees", path: "/employees", icon: Users, permission: "viewEmployees" },
    { id: "departments", name: "Departments", path: "/departments", icon: Building, permission: "manageDepartments" },
    { id: "job-positions", name: "Job Positions", path: "/job-positions", icon: Briefcase, permission: "viewEmployees" },
    { id: "work-locations", name: "Work Locations", path: "/work-locations", icon: MapPin, permission: "viewEmployees" },
    { id: "org-chart", name: "Org Chart", path: "/org-chart", icon: Users, permission: "viewEmployees" },
    { id: "reports", name: "HR Reports", path: "/reports", icon: BarChart3, permission: "viewEmployees" },
    { id: "configuration", name: "Employee Configuration", path: "/configuration", icon: Settings, permission: "manageEmployees" },
  ],
};

/**
 * Time Off App — Odoo `hr_holidays` equivalent.
 * Admin surface for leave types, allocations, public holidays, and approvals.
 * Self-service leave requests live under `/me/leave`.
 */
export const TIME_OFF_APP: AppDefinition = {
  id: "time-off",
  name: "Time Off",
  description: "Leave types, allocations, public holidays, and approvals",
  icon: CalendarOff,
  color: "hsl(199, 89%, 48%)", // Sky blue
  basePath: "/hr",
  requiredPlan: "professional",
  requiredPermissions: ["viewLeave", "approveLeave", "manageLeaveTypes"],
  sortOrder: 8.1,
  defaultModule: "leave",
  internalOnly: true,
  dependsOn: ["employees"],
  modules: [
    { id: "leave", name: "Leave Requests", path: "/leave", icon: CalendarOff, permission: "viewLeave" },
    { id: "leave-allocations", name: "Allocations", path: "/leave/allocations", icon: CalendarCheck, permission: "manageLeaveTypes" },
  ],
};

/**
 * Attendance App — Odoo `hr_attendance` equivalent.
 * Admin clock-in oversight, work schedules, and timesheet approvals.
 * Drives work-entries that feed Payroll. Personal attendance/timesheet
 * entry lives under `/me/attendance` and `/me/timesheets`.
 */
export const ATTENDANCE_APP: AppDefinition = {
  id: "attendance",
  name: "Attendances",
  description: "Attendance oversight, work schedules, and timesheet approvals",
  icon: Clock,
  color: "hsl(173, 80%, 40%)", // Teal
  basePath: "/hr",
  requiredPlan: "professional",
  requiredPermissions: ["viewAttendance", "manageAttendance", "approveTimesheets"],
  sortOrder: 8.2,
  defaultModule: "attendance",
  internalOnly: true,
  dependsOn: ["employees"],
  modules: [
    { id: "attendance", name: "Attendance", path: "/attendance", icon: Clock, permission: "viewAttendance" },
    { id: "corrections", name: "Corrections", path: "/attendance/corrections", icon: FileEdit, permission: "manageAttendance" },
    { id: "reports", name: "Reports", path: "/attendance/reports", icon: FileText, permission: "viewAttendance" },
    { id: "settings", name: "Attendance Settings", path: "/attendance/settings", icon: Settings, permission: "manageAttendance" },
    { id: "kiosk", name: "Kiosk Mode", path: "/kiosk/attendance", icon: ShieldCheck, permission: "viewAttendance" },
    { id: "work-schedules", name: "Work Schedules", path: "/work-schedules", icon: Calendar, permission: "manageWorkSchedule" },
    { id: "timesheets", name: "Timesheets", path: "/timesheets", icon: Clock, permission: "approveTimesheets" },
  ],
};

/**
 * Payroll App — Odoo `hr_payroll` equivalent.
 * Sensitive money-touching app. Strictly gated by payroll permissions.
 * Requires Employees + Contracts + Statutory rules to be configured before use.
 */
export const PAYROLL_APP: AppDefinition = {
  id: "payroll",
  name: "Payroll",
  description: "Salary structures, payroll runs, payslips, loans, and remittances",
  icon: Calculator,
  color: "hsl(142, 76%, 36%)", // Emerald green
  basePath: "/hr",
  requiredPlan: "professional",
  requiredPermissions: ["viewPayroll", "runPayroll", "managePayroll"],
  sortOrder: 8.3,
  defaultModule: "payroll",
  internalOnly: true,
  dependsOn: ["employees", "finance"],
  modules: [
    { id: "payroll", name: "Payroll Runs", path: "/payroll", icon: Calculator, permission: "viewPayroll" },
    { id: "loans", name: "Loans & Advances", path: "/payroll/loans", icon: Wallet, permission: "manageEmployeeLoans" },
    { id: "statutory-rules", name: "Statutory Rules", path: "/payroll/statutory-rules", icon: Shield, permission: "manageStatutoryRules" },
    { id: "remittances", name: "Remittances", path: "/remittances", icon: Landmark, permission: "viewRemittances" },
    { id: "settings", name: "Payroll Settings", path: "/payroll/configuration", icon: Settings, permission: "managePayroll" },
  ],
};

/**
 * Timesheets App — Odoo `hr_timesheet` equivalent.
 * Admin-side timesheet review/approval surface. Self-service entry lives
 * under `/me/timesheets`. Depends on Employees; optionally integrates with
 * Projects and Payroll if those apps are also installed.
 */
export const TIMESHEETS_APP: AppDefinition = {
  id: "timesheets",
  name: "Timesheets",
  description: "Team time approvals, reports, and project time billing (admin surface; employees enter time under My Workspace)",
  icon: Clock,
  color: "hsl(199, 89%, 48%)", // Sky blue
  basePath: "/timesheets",
  requiredPlan: "professional",
  requiredPermissions: ["approveTimesheets"],
  sortOrder: 8.25,
  defaultModule: "approvals",
  internalOnly: true,
  dependsOn: ["employees"],
  modules: [
    { id: "approvals", name: "Approvals", path: "", icon: ClipboardList, permission: "approveTimesheets" },
    { id: "team", name: "Team", path: "/team", icon: Users, permission: "viewTeamTimesheets" },
    { id: "by-project", name: "By Project", path: "/by-project", icon: BarChart3, permission: "viewTimesheets" },
    { id: "reports", name: "Reports", path: "/reports", icon: BarChart3, permission: "viewTimesheets" },
    { id: "settings", name: "Settings", path: "/settings", icon: Settings, permission: "approveTimesheets" },
  ],
};

/**
 * RECRUITMENT_APP retired 2026-05-09 — out of accounting scope.
 */

/**
 * Talent App — Performance, Goals, Competencies, Learning, Development.
 *
 * The "Talent Management" surface for HR and managers. Connects cycles →
 * goals → reviews → competency assessments → development plans → training.
 * Employee-facing surfaces for the same data live under `/me/talent/*`.
 */
export const TALENT_APP: AppDefinition = {
  id: "talent",
  name: "Talent",
  description: "Performance cycles, goals, competencies, reviews, development plans, and learning",
  icon: Target,
  color: "hsl(262, 83%, 58%)",
  basePath: "/hr/talent",
  requiredPlan: "professional",
  requiredPermissions: ["manageEmployees"],
  sortOrder: 8.4,
  defaultModule: "dashboard",
  internalOnly: true,
  dependsOn: ["employees"],
  modules: [
    { id: "dashboard",    name: "Dashboard",         path: "/dashboard",    icon: LayoutGrid,    permission: "manageEmployees" },
    { id: "cycles",       name: "Performance Cycles",path: "/cycles",       icon: CalendarCheck, permission: "manageEmployees" },
    { id: "goals",        name: "Goals",             path: "/goals",        icon: Target,        permission: "manageEmployees" },
    { id: "reviews",      name: "Reviews",           path: "/reviews",      icon: ClipboardList, permission: "manageEmployees" },
    { id: "competencies", name: "Competencies",      path: "/competencies", icon: Briefcase,     permission: "manageEmployees" },
    { id: "development",  name: "Development Plans", path: "/development",  icon: PenTool,       permission: "manageEmployees" },
    { id: "learning",     name: "Learning",          path: "/learning",     icon: BookOpen,      permission: "manageEmployees" },
    { id: "nine-box",     name: "9-Box Grid",        path: "/nine-box",     icon: LayoutGrid,    permission: "manageEmployees" },
    { id: "succession",   name: "Succession",        path: "/succession",   icon: Shield,        permission: "manageEmployees" },
    { id: "merit",        name: "Merit & Comp",      path: "/merit",        icon: DollarSign,    permission: "manageEmployees" },
    { id: "learning-paths", name: "Learning Paths",  path: "/learning/paths", icon: GraduationCap, permission: "manageEmployees" },
    { id: "analytics",    name: "Analytics",         path: "/analytics",    icon: BarChart3,     permission: "manageEmployees" },
  ],
};


/**
 * Organization App — structural surface for the HR domain.
 *
 * Departments, job positions, work locations, branches, org chart, and
 * structural change history. Distinct from Employees (people lifecycle) and
 * from Talent (performance). PlatformShell consumes this directly via the
 * `app` prop on `OrgRoutes`; it shares the `/hr` URL space so it is not
 * resolvable via `getAppByPath`, which is intentional — the dispatcher owns
 * `/hr` routing and hands off to this app's shell.
 */
export const ORG_APP: AppDefinition = {
  id: "org",
  name: "Organization",
  description: "Departments, positions, locations, hierarchy, and structural change history",
  icon: Building,
  color: "hsl(220, 70%, 50%)",
  basePath: "/hr/org",
  requiredPlan: "professional",
  requiredPermissions: ["viewEmployees"],
  sortOrder: 8.05,
  defaultModule: "overview",
  internalOnly: true,
  dependsOn: ["employees"],
  modules: [
    { id: "overview",    name: "Overview",     path: "/",            icon: LayoutDashboard, permission: "viewEmployees" },
    { id: "departments", name: "Departments",  path: "/departments", icon: Building,        permission: "manageDepartments" },
    { id: "positions",   name: "Positions",    path: "/positions",   icon: Briefcase,       permission: "viewEmployees" },
    { id: "locations",   name: "Locations",    path: "/locations",   icon: MapPin,          permission: "viewEmployees" },
    { id: "chart",       name: "Org Chart",    path: "/chart",       icon: Users,           permission: "viewEmployees" },
    { id: "history",     name: "Change Log",   path: "/history",     icon: History,         permission: "viewEmployees" },
  ],
};

/**
 * Contracts — employment agreement lifecycle (drafts → pending → active →
 * expiring → renewed / amended / terminated).
 *
 * NOT an independently installable app. Contracts is a workspace *inside*
 * the Employees app (like Lifecycle, Document Compliance and HR Reports):
 * it shares the `employees` entitlement, install state and app rail entry,
 * and is never listed in APP_REGISTRY or the marketplace.
 *
 * @deprecated Do not pass this to `<PlatformShell app=...>` or any install /
 * entitlement check — use `EMPLOYEES_APP`. Kept only as a module manifest
 * for nav/command-palette metadata.
 */
export const CONTRACTS_APP: AppDefinition = {

  id: "contracts",
  name: "Contracts",
  description: "Employment contracts, renewals, amendments, and templates",
  icon: FileText,
  color: "hsl(280, 60%, 50%)",
  basePath: "/hr/contracts",
  requiredPlan: "professional",
  requiredPermissions: ["viewEmployees"],
  sortOrder: 8.06,
  defaultModule: "overview",
  internalOnly: true,
  dependsOn: ["employees"],
  modules: [
    { id: "overview",   name: "Overview",          path: "/",           icon: LayoutDashboard, permission: "viewEmployees" },
    { id: "all",        name: "All contracts",     path: "/all",        icon: FileText,        permission: "viewEmployees" },
    { id: "drafts",     name: "Drafts",            path: "/drafts",     icon: FileEdit,        permission: "viewEmployees" },
    { id: "pending",    name: "Pending approval",  path: "/pending",    icon: Inbox,           permission: "viewEmployees" },
    { id: "active",     name: "Active",            path: "/active",     icon: ShieldCheck,     permission: "viewEmployees" },
    { id: "expiring",   name: "Expiring",          path: "/expiring",   icon: Bell,            permission: "viewEmployees" },
    { id: "renewals",   name: "Renewals",          path: "/renewals",   icon: RefreshCw,       permission: "viewEmployees" },
    { id: "amendments", name: "Amendments",        path: "/amendments", icon: PenTool,         permission: "viewEmployees" },
    { id: "templates",  name: "Templates",         path: "/templates",  icon: FileBox,         permission: "viewEmployees" },
  ],
};




/**
 * @deprecated Use EMPLOYEES_APP / TIME_OFF_APP / ATTENDANCE_APP / PAYROLL_APP / RECRUITMENT_APP instead.
 * Kept ONLY as a compatibility alias for legacy entitlement rows where `app_id='hr'`
 * still exists in `plan_app_access` / `organization_installed_apps`. The routing layer
 * resolves `hr` to `employees`. New code MUST NOT reference HR_APP.
 */
export const HR_APP: AppDefinition = EMPLOYEES_APP;

/**
 * Projects App - Project management and timesheets
 */
export const PROJECTS_APP: AppDefinition = {
  id: "projects",
  name: "Projects",
  description: "Projects, tasks, milestones, profitability and reporting",
  icon: FolderKanban,
  color: "hsl(199, 89%, 48%)", // Sky blue
  basePath: "/projects-app",
  requiredPlan: "professional",
  requiredPermissions: ["viewProjects"],
  sortOrder: 9,
  defaultModule: "overview",
  provides: ["projects.analytic-tagging", "projects.task-linking"],
  modules: [
    { id: "overview",      name: "Overview",      path: "/overview",      icon: LayoutGrid,    permission: "viewProjects" },
    { id: "my-tasks",      name: "My Tasks",      path: "/my-tasks",      icon: ListFilter,    permission: "viewProjects" },
    { id: "tasks",         name: "All Tasks",     path: "/tasks",         icon: ClipboardList, permission: "viewProjects" },
    { id: "list",          name: "Projects",      path: "/list",          icon: FolderKanban,  permission: "viewProjects" },
    { id: "milestones",    name: "Milestones",    path: "/milestones",    icon: Target,        permission: "viewProjects" },
    { id: "documents",     name: "Documents",     path: "/documents",     icon: FileBox,       permission: "viewProjects" },
    { id: "workload",      name: "Workload",      path: "/workload",      icon: Users,         permission: "viewProjects" },
    { id: "reports",       name: "Reports",       path: "/reports",       icon: BarChart3,     permission: "viewProjects" },
    { id: "configuration", name: "Configuration", path: "/configuration", icon: Settings,      permission: "manageProjects" },
  ],
};

/**
 * Reports App - Business intelligence and analytics
 */
export const REPORTS_APP: AppDefinition = {
  id: "reports",
  name: "Reports",
  description: "Financial reports, analytics, and business intelligence",
  icon: BarChart3,
  color: "hsl(280, 65%, 60%)", // Violet
  // Reports have no standalone router mount — they live under the Finance app
  // routes (/finance/reports/*). Pointing the tile at /reports 404'd.
  basePath: "/finance/reports",
  requiredPlan: "starter",
  requiredPermissions: ["viewReports"],
  sortOrder: 10,
  internalOnly: true,
  defaultModule: "reports",
  modules: [
    { id: "reports", name: "All Reports", path: "", icon: BarChart3, permission: "viewReports" },
    { id: "financial", name: "Financial Statements", path: "/financial", icon: PiggyBank, permission: "viewReports" },
    { id: "trial-balance", name: "Trial Balance", path: "/trial-balance", icon: Calculator, permission: "viewReports" },
    { id: "general-ledger", name: "General Ledger", path: "/general-ledger", icon: BookOpen, permission: "viewReports" },
    { id: "partner-ledger", name: "Partner Ledger", path: "/partner-ledger", icon: FileText, permission: "viewReports" },
    { id: "journal-report", name: "Journal Report", path: "/journal-report", icon: BookOpen, permission: "viewReports" },
    { id: "aging", name: "Aging Reports", path: "/aging", icon: Clock, permission: "viewReports" },
    { id: "budget", name: "Budget vs Actual", path: "/budget", icon: Target, permission: "viewReports" },
    { id: "depreciation", name: "Depreciation", path: "/depreciation", icon: Building2, permission: "viewReports" },
    { id: "cash-flow", name: "Cash Flow", path: "/cash-flow", icon: Wallet, permission: "viewReports" },
    { id: "audit-trail", name: "Audit Trail", path: "/audit-trail", icon: History, permission: "viewReports" },
    { id: "sales", name: "Sales Reports", path: "/sales", icon: FileText, permission: "viewReports" },
    { id: "management", name: "Management", path: "/management", icon: BarChart3, permission: "viewReports" },
    { id: "tax", name: "Tax Reports", path: "/tax", icon: Receipt, permission: "viewReports" },
    // Inventory family — dual-hosted (ADR 0143). These paths are the Finance
    // mounts; the Inventory shell mounts the same pages under /inventory-app.
    { id: "stock", name: "Stock Reports", path: "/stock", icon: Package, permission: "viewReports" },
    { id: "inventory-valuation", name: "Inventory Valuation", path: "/inventory-valuation", icon: Package, permission: "viewReports" },
    { id: "stock-ledger", name: "Stock Ledger", path: "/stock-ledger", icon: BookOpen, permission: "viewReports" },
    { id: "stock-aging", name: "Stock Aging", path: "/stock-aging", icon: Clock, permission: "viewReports" },
    { id: "lot-traceability", name: "Lot Traceability", path: "/lot-traceability", icon: Package, permission: "viewReports" },
    { id: "stock-adjustments", name: "Stock Adjustments", path: "/stock-adjustments", icon: Package, permission: "viewReports" },
    { id: "stock-transfers", name: "Stock Transfers", path: "/stock-transfers", icon: Package, permission: "viewReports" },
    { id: "intelligence", name: "Business Intelligence", path: "/intelligence", icon: BarChart3, permission: "viewReports" },
  ],
};

/**
 * Documents App retired 2026-05-16 — productivity-only file storage, not part of accounting.
 */

/**
 * SIGN_APP and SPREADSHEETS_APP retired 2026-05-09 — out of accounting scope.
 * Pages, hooks, components, and edge functions deleted. Marketplace tiles
 * no longer registered.
 */

/**
 * Studio App - Customization, automation, and report scheduling
 */
export const STUDIO_APP: AppDefinition = {
  id: "studio",
  name: "Studio",
  description: "Customize fields, forms, automations, and report scheduling",
  icon: Wand2,
  color: "hsl(270, 70%, 50%)", // Purple
  basePath: "/studio",
  requiredPlan: "starter",
  requiredPermissions: ["editSettings"],
  sortOrder: 15,
  internalOnly: true,
  defaultModule: "fields",
  modules: [
    { id: "fields", name: "Fields", path: "", icon: Wand2, permission: "editSettings" },
    { id: "forms", name: "Forms", path: "/forms", icon: LayoutGrid, permission: "editSettings" },
    { id: "automations", name: "Automations", path: "/automations", icon: Zap, permission: "editSettings" },
    { id: "views", name: "Views", path: "/views", icon: BarChart3, permission: "editSettings" },
    { id: "approvals", name: "Approvals", path: "/approvals", icon: Shield, permission: "editSettings" },
    { id: "reports", name: "Reports", path: "/reports", icon: FileText, permission: "editSettings" },
    { id: "scheduling", name: "Scheduling", path: "/scheduling", icon: CalendarClock, permission: "editSettings" },
  ],
};

/**
 * Platform App - Settings, team, and system configuration
 */
export const PLATFORM_APP: AppDefinition = {
  id: "platform",
  name: "Settings",
  description: "Organization settings, team management, and configuration",
  icon: Settings,
  color: "hsl(0, 0%, 45%)", // Gray
  basePath: "/settings",
  requiredPlan: "starter",
  requiredPermissions: [],
  sortOrder: 100,
  isPlatform: true,
  defaultModule: "general",
  modules: [
    { id: "general", name: "General", path: "", icon: Settings, permission: "editSettings" },
    { id: "team", name: "Team", path: "/team", icon: UserPlus, permission: "manageTeam" },
    { id: "migration", name: "Data Migration", path: "/migration", icon: GitCompare, permission: "editSettings", description: "Import financial data from another system" },
    { id: "studio", name: "Studio", path: "/studio", icon: Wand2, permission: "editSettings", description: "Customize fields, forms, and workflows" },
    { id: "audit-logs", name: "Audit Logs", path: "/audit-logs", icon: History, permission: "viewAuditLogs" },
    { id: "compliance", name: "Compliance", path: "/compliance", icon: Shield, permission: "viewReports" },
  ],
};

/**
 * Hardware App — workspace-wide device & peripheral registry.
 *
 * Hardware is a PLATFORM concern (Inventory, Warehouse, POS, HR, Mfg all
 * consume printers/scanners/scales), so it lives at /platform/hardware and
 * is reachable from the main app launcher — not buried under POS.
 */
export const HARDWARE_APP: AppDefinition = {
  id: "hardware",
  name: "Hardware",
  description: "Printers, scanners, scales, displays, cash drawers — shared across all modules",
  icon: Cpu,
  color: "hsl(217, 91%, 60%)",
  basePath: "/platform/hardware",
  requiredPlan: "starter",
  requiredPermissions: ["editSettings"],
  sortOrder: 95,
  isPlatform: true,
  defaultModule: "devices",
  modules: [
    { id: "devices", name: "Devices", path: "/devices", icon: Cpu, permission: "editSettings", description: "Register, assign, and manage hardware devices per company / branch" },
    { id: "diagnostics", name: "Diagnostics", path: "/diagnostics", icon: Activity, permission: "editSettings", description: "Live status, ping, and test dispatches for connected devices" },
  ],
};


/**
 * SMS App - Third-party SMS integration (BYO Twilio)
 */
export const SMS_APP: AppDefinition = {
  id: "sms",
  name: "Twilio SMS",
  description: "SMS notifications via Twilio (Bring Your Own Account)",
  icon: MessageSquare,
  color: "hsl(199, 89%, 48%)",
  basePath: "/sms",
  requiredPlan: "starter",
  requiredPermissions: ["editSettings"],
  sortOrder: 20,
  defaultModule: "settings",
  internalOnly: true,
  isConfigurationApp: true,
  modules: [
    { id: "settings", name: "Configuration", path: "/settings", icon: Settings, permission: "editSettings" },
    { id: "templates", name: "Templates", path: "/templates", icon: FileText, permission: "editSettings" },
    { id: "rules", name: "Event Rules", path: "/rules", icon: Zap, permission: "editSettings" },
    { id: "recipient-groups", name: "Recipient Groups", path: "/recipient-groups", icon: Users, permission: "editSettings" },
    { id: "opt-outs", name: "Opt-Outs", path: "/opt-outs", icon: Ban, permission: "editSettings" },
    { id: "log", name: "SMS Log", path: "/log", icon: ScrollText, permission: "editSettings" },
  ],
};

/**
 * My Workspace App — personal employee self-service shell.
 *
 * Treated as just another app so portal users and internal users alike get
 * the same `AppWorkspaceLayout` top-bar + module-tabs experience instead of
 * a parallel sidebar codebase. `hideAppSwitcher` suppresses the grid icon
 * and "Switch App" menu since this shell is single-purpose.
 *
 * Excluded from the global app switcher / marketplace by explicit filter in
 * useAppNavigation and getAppGroups.
 */
export const ME_APP: AppDefinition = {
  id: "me",
  name: "My Workspace",
  description: "Your personal workspace — leave, timesheets, payslips, documents",
  icon: LayoutGrid,
  color: "hsl(217, 91%, 60%)",
  basePath: "/me",
  requiredPermissions: [],
  sortOrder: 0,
  defaultModule: "home",
  isPlatform: true,
  internalOnly: false,
  hideAppSwitcher: true,
  modules: [
    { id: "home",        name: "Home",        path: "",            icon: LayoutGrid },
    { id: "leave",       name: "Time off",    path: "/leave",       icon: CalendarOff,    permission: "viewLeave" },
    { id: "timesheets",  name: "Timesheets",  path: "/timesheets",  icon: Clock,          permission: "viewTimesheets" },
    { id: "attendance",  name: "Attendance",  path: "/attendance",  icon: ClipboardList,  permission: "viewAttendance" },
    { id: "shifts",      name: "Shifts",      path: "/shifts",      icon: CalendarClock },
    { id: "payslips",    name: "Payslips",    path: "/payslips",    icon: Wallet },
    { id: "loans",       name: "Loans",       path: "/loans",       icon: HandCoins },
    { id: "documents",   name: "Documents",   path: "/documents",   icon: FileText },
    { id: "onboarding",  name: "Onboarding",  path: "/onboarding",  icon: ClipboardList },
    { id: "exit",        name: "Exit",        path: "/exit",        icon: RotateCcw },
    { id: "profile",     name: "Profile",     path: "/profile",     icon: UserCheck },
    { id: "settings",    name: "Settings",    path: "/settings",    icon: Settings },
  ],
};

/**
 * Dashboard App — the global home / executive workspace.
 *
 * Promotes the legacy "/dashboard" page to a first-class workspace inside
 * the unified PlatformShell, retiring the parallel DashboardLayout +
 * AppAwareSidebar chrome. Sits at sortOrder 1 so it's the first icon on
 * the AppRail right after Home.
 */
export const DASHBOARD_APP: AppDefinition = {
  id: "dashboard",
  name: "Home",
  description: "Overview, activity, approvals, and key insights across your workspace",
  icon: LayoutDashboard,
  color: "hsl(217, 91%, 60%)",
  basePath: "/dashboard",
  requiredPermissions: [],
  sortOrder: 1,
  defaultModule: "overview",
  isPlatform: true,
  modules: [
    { id: "overview",  name: "Overview",  path: "",           icon: LayoutDashboard },
    { id: "activity",  name: "Activity",  path: "/activity",  icon: Bell },
    { id: "approvals", name: "Approvals", path: "/approvals", icon: Inbox },
    { id: "insights",  name: "Insights",  path: "/insights",  icon: Sparkles },
  ],
};

/**
 * Complete app registry - all apps in the system
 */
export const APP_REGISTRY: AppDefinition[] = [
  DASHBOARD_APP,
  ME_APP,
  FINANCE_APP,
  SALES_APP,
  CONTACTS_APP,
  PURCHASES_APP,
  INVENTORY_APP,
  WAREHOUSE_APP,
  POS_APP,
  CRM_APP,
  // HR domain — split into 5 Odoo-aligned apps (Employees is foundational)
  EMPLOYEES_APP,
  TIME_OFF_APP,
  ATTENDANCE_APP,
  TIMESHEETS_APP,
  PAYROLL_APP,
  TALENT_APP,
  // RECRUITMENT_APP retired 2026-05-09
  PROJECTS_APP,
  REPORTS_APP,
  STUDIO_APP,
  // DOCUMENTS_APP retired 2026-05-16
  // SIGN_APP + SPREADSHEETS_APP retired 2026-05-09
  SMS_APP,
  HARDWARE_APP,
  PLATFORM_APP,
];

/**
 * Get an app by its ID
 */
export function getAppById(appId: string): AppDefinition | undefined {
  return APP_REGISTRY.find(app => app.id === appId);
}

/**
 * Get an app by a route path
 */
export function getAppByPath(path: string): AppDefinition | undefined {
  // Remove leading slash and get first segment
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  const firstSegment = cleanPath.split("/")[0];
  
  return APP_REGISTRY.find(app => {
    const appSegment = app.basePath.replace(/^\//, "");
    return appSegment === firstSegment;
  });
}

/**
 * Get module by path within an app
 */
export function getModuleByPath(app: AppDefinition, path: string): ModuleDefinition | undefined {
  // Get the path after the app's base path
  const relativePath = path.replace(app.basePath, "") || "/";
  
  return app.modules.find(module => {
    const modulePath = module.path || "/";
    return relativePath === modulePath || relativePath.startsWith(modulePath + "/");
  });
}

/**
 * Group apps by category for the app switcher.
 *
 * Categories are curated, but the grouping is **exhaustive by construction**:
 * any registered app that isn't explicitly categorised falls into "Other apps"
 * instead of silently disappearing from the switcher (the bug that hid
 * Warehouse and Talent). `me` is the only deliberate exclusion — it has its
 * own single-purpose shell (`hideAppSwitcher`).
 */
export function getAppGroups(): AppGroup[] {
  const bySortOrder = (a: AppDefinition, b: AppDefinition) =>
    (a.sortOrder || 0) - (b.sortOrder || 0);

  const CATEGORY_MEMBERSHIP: Array<{ label: string; ids: string[] }> = [
    { label: "Core", ids: ["finance", "sales", "contacts", "purchases", "inventory"] },
    { label: "Operations", ids: ["warehouse", "pos", "crm", "projects", "studio"] },
    // HR Suite — Odoo-aligned grouping. The apps stay independently
    // installable (Employees is foundational, the others depend on it),
    // but the switcher shows them under one heading.
    { label: "Human Resources", ids: ["employees", "time-off", "attendance", "timesheets", "payroll", "talent"] },
    { label: "Analytics", ids: ["reports"] },
    { label: "Integrations", ids: ["sms"] },
  ];

  const switchable = APP_REGISTRY.filter(
    (app) => app.id !== "me" && !app.hideAppSwitcher,
  );

  const groups: AppGroup[] = CATEGORY_MEMBERSHIP.map(({ label, ids }) => ({
    label,
    apps: switchable.filter((app) => ids.includes(app.id)).sort(bySortOrder),
  }));

  const platformApps = switchable.filter((app) => app.isPlatform).sort(bySortOrder);
  groups.push({ label: "Platform", apps: platformApps });

  // Catch-all: anything registered but not placed above.
  const placed = new Set(groups.flatMap((g) => g.apps.map((a) => a.id)));
  const uncategorised = switchable.filter((app) => !placed.has(app.id)).sort(bySortOrder);
  if (uncategorised.length > 0) {
    groups.push({ label: "Other apps", apps: uncategorised });
  }

  return groups.filter((group) => group.apps.length > 0);

}

/**
 * Legacy route mappings for backward compatibility
 * Maps old flat routes to new app-based routes
 */
export const LEGACY_ROUTE_MAPPINGS: Record<string, string> = {
  // Finance
  "/accounts": "/finance/accounts",
  "/journal-entries": "/finance/journal-entries",
  "/fiscal-periods": "/finance/fiscal-periods",
  "/budgets": "/finance/budgets",
  "/fixed-assets": "/finance/fixed-assets",
  "/banking": "/finance/banking",
  "/bank-feeds": "/finance/bank-feeds",
  "/bank-reconciliation": "/finance/reconciliation",
  
  // Sales
  "/invoices": "/sales/invoices",
  "/recurring-invoices": "/sales/recurring",
  "/estimates": "/sales/estimates",
  "/proforma-invoices": "/sales/proforma",
  "/sales-orders": "/sales/orders",
  "/delivery-notes": "/sales/delivery-notes",
  "/customer-payments": "/sales/payments",
  "/customer-statements": "/sales/statements",
  "/sales-returns": "/sales/returns",
  "/credit-notes": "/sales/credit-notes",
  
  // Purchases
  "/bills": "/purchases/bills",
  "/purchase-orders": "/purchases/orders",
  "/expenses": "/purchases/expenses",
  "/purchase-returns": "/purchases/returns",
  
  // Inventory (using inventory-app to avoid conflicts)
  "/products": "/inventory-app/products",
  "/inventory": "/inventory-app/stock",
  "/warehouses": "/warehouse-app/warehouses",
  
  // POS (dashboard is the main entry point, terminal requires register selection)
  "/pos": "/pos",
  "/pos/reports": "/pos/reports",
  "/pos/settings": "/pos/settings",
  
  // CRM (using crm-app to avoid conflicts with legacy /crm)
  "/crm": "/crm-app/pipeline",
  "/crm/activities": "/crm-app/activities",
  
  // Contacts (using contacts-app for the central hub)
  "/contacts": "/contacts-app",
  
  // HR
  "/employees": "/hr/employees",
  "/departments": "/hr/employees/departments",
  "/leave": "/hr/leave",
  "/payroll": "/hr/payroll",
  
  // Projects (using projects-app to avoid conflicts with legacy /projects)
  "/projects": "/projects-app/list",
  
  // Reports (mounted under the Finance app router)
  "/reports": "/finance/reports",
  "/reports/financial": "/finance/reports/financial",
  "/reports/trial-balance": "/finance/reports/trial-balance",
  "/reports/general-ledger": "/finance/reports/general-ledger",
  "/reports/aging": "/finance/reports/aging",
  "/reports/sales": "/finance/reports/sales",
  "/reports/management": "/finance/reports/management",
  "/reports/tax": "/finance/reports/tax",
  "/reports/stock": "/finance/reports/stock",
  "/business-intelligence": "/finance/reports/intelligence",
  
  // Platform/Settings
  "/settings": "/settings",
  "/team": "/settings/team",
  "/studio": "/settings/studio",
  "/audit-logs": "/settings/audit-logs",
  "/compliance": "/settings/compliance",
};

/**
 * Get the new route for a legacy path
 */
export function getLegacyRouteRedirect(path: string): string | null {
  return LEGACY_ROUTE_MAPPINGS[path] || null;
}
