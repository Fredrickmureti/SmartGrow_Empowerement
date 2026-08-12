/**
 * Action Registry
 *
 * Single source of truth for "+ Create" style commands.
 * Extracted out of GlobalCreateMenu so both the create flyout and the
 * global command palette render from the same list — no drift possible.
 *
 * Every action is gated declaratively (permission / feature / appInstall);
 * `filterAccessible()` in buildIndex applies the same gates the create
 * menu used to apply with hand-written `if` checks.
 */

import {
  FileText, Receipt, CreditCard, ClipboardList, UserPlus, Package,
  BookOpen, ArrowLeftRight, Clock, CalendarDays, Landmark, Truck,
  RotateCcw, FileCheck, Target, Briefcase, CalendarOff, ShoppingCart,
  FolderKanban, type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/permissions";

export type ActionCategory =
  | "sales"
  | "purchases"
  | "inventory"
  | "accounting"
  | "hr"
  | "projects"
  | "crm"
  | "contacts";

export const ACTION_CATEGORY_LABELS: Record<ActionCategory, string> = {
  sales: "Customers / Sales",
  purchases: "Suppliers / Purchases",
  inventory: "Inventory",
  accounting: "Accounting",
  hr: "Team / HR",
  projects: "Projects",
  crm: "CRM",
  contacts: "Contacts",
};

export const ACTION_CATEGORY_ORDER: ActionCategory[] = [
  "sales", "purchases", "inventory", "accounting", "hr", "projects", "crm", "contacts",
];

export interface ActionDefinition {
  id: string;
  category: ActionCategory;
  label: string;
  icon: LucideIcon;
  /** Target route. Query params (if any) appended verbatim. */
  path: string;
  queryParams?: string;
  /** Search keywords (lowercase). */
  keywords?: string[];
  /** App that must be installed. */
  appInstall?: string;
  /** Required permission OR any-of (`permissionsAny`). */
  permission?: Permission;
  permissionsAny?: Permission[];
}

/**
 * Hand-translated from src/components/navigation/GlobalCreateMenu.tsx.
 * Every action there has a 1:1 entry here with the same gating semantics.
 */
export const ACTION_REGISTRY: ActionDefinition[] = [
  // ── Customers / Sales ──────────────────────────────────────────────
  {
    id: "create-invoice", category: "sales", label: "Invoice", icon: FileText,
    path: "/sales/invoices", queryParams: "action=create",
    keywords: ["new", "create", "bill customer"],
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "create-recurring-invoice", category: "sales", label: "Recurring Invoice", icon: Receipt,
    path: "/sales/recurring", queryParams: "action=create",
    keywords: ["subscription", "repeating"],
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "create-estimate", category: "sales", label: "Estimate", icon: ClipboardList,
    path: "/sales/estimates", queryParams: "action=create",
    keywords: ["quote", "quotation"],
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "create-proforma", category: "sales", label: "Proforma Invoice", icon: FileCheck,
    path: "/sales/proforma", queryParams: "action=create",
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "create-sales-order", category: "sales", label: "Sales Order", icon: ClipboardList,
    path: "/sales/orders", queryParams: "action=create",
    keywords: ["so"],
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "create-credit-note", category: "sales", label: "Credit Note", icon: Receipt,
    path: "/sales/credit-notes", queryParams: "action=create",
    keywords: ["refund"],
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "create-sales-return", category: "sales", label: "Sales Return", icon: RotateCcw,
    path: "/sales/returns", queryParams: "action=create",
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "receive-payment", category: "sales", label: "Receive Payment", icon: CreditCard,
    path: "/sales/payments", queryParams: "action=create",
    keywords: ["customer payment"],
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "create-delivery-note", category: "sales", label: "Delivery Note", icon: Truck,
    path: "/sales/delivery-notes", queryParams: "action=create",
    keywords: ["dispatch", "shipment"],
    appInstall: "sales", permissionsAny: ["manageSales", "manageFinancials"],
  },
  {
    id: "create-customer", category: "sales", label: "Customer", icon: UserPlus,
    path: "/contacts-app/customers", queryParams: "action=create&type=customer",
    keywords: ["client", "buyer"],
    appInstall: "contacts", permission: "manageContacts",
  },

  // ── Suppliers / Purchases ──────────────────────────────────────────
  {
    id: "create-expense", category: "purchases", label: "Expense", icon: Receipt,
    path: "/purchases/expenses", queryParams: "action=create",
    appInstall: "purchases", permissionsAny: ["managePurchases", "manageFinancials"],
  },
  {
    id: "create-bill", category: "purchases", label: "Bill", icon: FileText,
    path: "/purchases/bills", queryParams: "action=create",
    keywords: ["vendor invoice", "ap invoice"],
    appInstall: "purchases", permissionsAny: ["managePurchases", "manageFinancials"],
  },
  {
    id: "create-purchase-order", category: "purchases", label: "Purchase Order", icon: ShoppingCart,
    path: "/purchases/orders", queryParams: "action=create",
    keywords: ["po"],
    appInstall: "purchases", permissionsAny: ["managePurchases", "manageFinancials"],
  },
  {
    id: "create-rfq", category: "purchases", label: "RFQ", icon: FileText,
    path: "/purchases/rfqs", queryParams: "action=create",
    keywords: ["request for quotation"],
    appInstall: "purchases", permissionsAny: ["managePurchases", "manageFinancials"],
  },
  {
    id: "create-purchase-return", category: "purchases", label: "Purchase Return", icon: RotateCcw,
    path: "/purchases/returns", queryParams: "action=create",
    appInstall: "purchases", permissionsAny: ["managePurchases", "manageFinancials"],
  },
  {
    id: "pay-bills", category: "purchases", label: "Pay Bills", icon: CreditCard,
    path: "/finance/payables",
    keywords: ["vendor payment"],
    appInstall: "purchases", permissionsAny: ["managePurchases", "manageFinancials"],
  },
  {
    id: "create-supplier", category: "purchases", label: "Supplier", icon: UserPlus,
    path: "/purchases/suppliers/new",
    keywords: ["vendor"],
    appInstall: "purchases", permission: "managePurchases",
  },

  // ── Inventory ──────────────────────────────────────────────────────
  {
    id: "create-product", category: "inventory", label: "Product", icon: Package,
    path: "/inventory-app/products", queryParams: "action=create",
    keywords: ["item", "sku"],
    appInstall: "inventory", permission: "manageProducts",
  },

  // ── Accounting ─────────────────────────────────────────────────────
  {
    id: "create-journal-entry", category: "accounting", label: "Journal Entry", icon: BookOpen,
    path: "/finance/journal-entries", queryParams: "action=create",
    keywords: ["je", "manual entry"],
    appInstall: "finance", permission: "manageFinancials",
  },
  {
    id: "create-bank-deposit", category: "accounting", label: "Bank Deposit", icon: Landmark,
    path: "/finance/journal-entries", queryParams: "action=create&type=deposit",
    appInstall: "finance", permission: "manageFinancials",
  },
  {
    id: "create-transfer", category: "accounting", label: "Transfer", icon: ArrowLeftRight,
    path: "/finance/journal-entries", queryParams: "action=create&type=transfer",
    keywords: ["bank transfer"],
    appInstall: "finance", permission: "manageFinancials",
  },
  {
    id: "create-budget", category: "accounting", label: "Budget", icon: Target,
    path: "/finance/budgets", queryParams: "action=create",
    appInstall: "finance", permission: "manageFinancials",
  },

  // ── HR ─────────────────────────────────────────────────────────────
  {
    id: "create-payroll-run", category: "hr", label: "Payroll Run", icon: CalendarDays,
    path: "/hr/payroll", queryParams: "action=create",
    appInstall: "hr", permission: "managePayroll",
  },
  {
    id: "create-employee", category: "hr", label: "Employee", icon: UserPlus,
    path: "/hr/employees", queryParams: "action=create",
    keywords: ["staff", "hire"],
    appInstall: "hr", permission: "viewEmployees" as Permission,
  },
  {
    id: "create-leave-request", category: "hr", label: "Leave Request", icon: CalendarOff,
    path: "/hr/leave", queryParams: "action=create",
    keywords: ["time off", "vacation"],
    appInstall: "hr", permission: "viewLeave" as Permission,
  },
  {
    id: "create-time-entry", category: "hr", label: "Time Entry", icon: Clock,
    path: "/timesheets", queryParams: "action=create",
    keywords: ["timesheet", "log hours", "time"],
    appInstall: "timesheets", permission: "viewTimesheets" as Permission,
  },

  // ── Projects ───────────────────────────────────────────────────────
  {
    id: "create-project", category: "projects", label: "Project", icon: FolderKanban,
    path: "/projects-app/list", queryParams: "action=create",
    appInstall: "projects", permission: "viewProjects" as Permission,
  },

  // ── CRM ────────────────────────────────────────────────────────────
  {
    id: "create-lead", category: "crm", label: "Lead / Opportunity", icon: Briefcase,
    path: "/crm-app/pipeline", queryParams: "action=create",
    keywords: ["deal", "prospect"],
    appInstall: "crm", permission: "viewContacts",
  },

  // ── Contacts (generic, when sales not installed) ───────────────────
  {
    id: "create-contact", category: "contacts", label: "Contact", icon: UserPlus,
    path: "/contacts-app", queryParams: "action=create",
    appInstall: "contacts", permission: "manageContacts",
  },
];
