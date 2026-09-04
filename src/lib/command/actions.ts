/**
 * Action Registry
 *
 * Single source of truth for "+ Create" style commands.
 * Both the create flyout and the global command palette render from this
 * list — no drift possible.
 *
 * Scope: microfinance operations (lending) plus the accounting surfaces the
 * institution actually runs. ERP sales/purchases/inventory/HR actions were
 * removed with those modules.
 */

import {
  UserPlus, Users, ClipboardList, HandCoins, Wallet,
  BookOpen, ArrowLeftRight, Landmark, type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/permissions";

export type ActionCategory = "lending" | "accounting" | "contacts";

export const ACTION_CATEGORY_LABELS: Record<ActionCategory, string> = {
  lending: "Lending",
  accounting: "Accounting",
  contacts: "Contacts",
};

export const ACTION_CATEGORY_ORDER: ActionCategory[] = [
  "lending", "accounting", "contacts",
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

export const ACTION_REGISTRY: ActionDefinition[] = [
  // ── Lending ────────────────────────────────────────────────────────
  {
    id: "create-client", category: "lending", label: "Client", icon: UserPlus,
    path: "/lending", queryParams: "action=create",
    keywords: ["borrower", "member", "kyc"],
    appInstall: "lending", permission: "viewClients" as Permission,
  },
  {
    id: "create-group", category: "lending", label: "Group", icon: Users,
    path: "/lending/groups", queryParams: "action=create",
    keywords: ["meeting", "centre"],
    appInstall: "lending", permission: "viewClients" as Permission,
  },
  {
    id: "create-application", category: "lending", label: "Loan Application", icon: ClipboardList,
    path: "/lending/applications", queryParams: "action=create",
    keywords: ["apply", "origination"],
    appInstall: "lending", permission: "viewApplications" as Permission,
  },
  {
    id: "record-repayment", category: "lending", label: "Repayment", icon: Wallet,
    path: "/lending/repayments", queryParams: "action=create",
    keywords: ["collection", "installment", "receipt"],
    appInstall: "lending", permission: "recordRepayments" as Permission,
  },
  {
    id: "view-loans", category: "lending", label: "Loan", icon: HandCoins,
    path: "/lending/loans",
    keywords: ["portfolio", "disbursement"],
    appInstall: "lending", permission: "viewLoans" as Permission,
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

  // ── Contacts ───────────────────────────────────────────────────────
  {
    id: "create-contact", category: "contacts", label: "Contact", icon: UserPlus,
    path: "/contacts-app", queryParams: "action=create",
    appInstall: "contacts", permission: "manageContacts",
  },
];
