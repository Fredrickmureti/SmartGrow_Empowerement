/**
 * Workspace navigation configs for the HR-domain sub-apps.
 *
 * One WorkspaceNav per sub-app, grouped Operations / Insights / Setup.
 * Drives the new PlatformShell's left-rail + sidebar; replaces the
 * legacy horizontal AppModuleTabs strip + per-page *SubNav stack.
 */
import {
  LayoutGrid,
  Users,
  Network,
  BarChart3,
  TrendingUp,
  Building2,
  Briefcase,
  MapPin,
  Settings,
  ClipboardList,
  ShieldCheck,
  FileBox,
  GraduationCap,
  CalendarOff,
  ScrollText,
  Wrench,
  CalendarCheck,
  CalendarDays,
  Inbox,
  ListChecks,
  Tags,
  Clock,
  Activity,
  CalendarClock,
  Smartphone,
  FolderKanban,
  LayoutDashboard,
  ClipboardCheck,
  Calculator,
  FileText,
  Banknote,
  Wallet,
  Shield,
  Landmark,
  Wand2,
  Globe,
  Layers,
  Scale,
  Ban,
  Target,
} from "lucide-react";
import { GitBranch, History, FileSignature, Users2, Network as NetIcon, FilePlus, Repeat, AlertCircle, Library, Settings2 } from "lucide-react";

import type { WorkspaceNav, WorkspaceNavItem } from "@/components/layout/shell/types";

export const TIME_OFF_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/hr/leave", label: "Overview", icon: CalendarCheck, end: true },
        { to: "/hr/leave/approvals", label: "Approvals", icon: Inbox },
        { to: "/hr/leave/calendar", label: "Team calendar", icon: CalendarDays },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/hr/leave/allocations", label: "Allocations", icon: ListChecks },
        { to: "/hr/leave/types", label: "Leave types", icon: Tags },
        { to: "/hr/leave/holidays", label: "Public holidays", icon: CalendarOff },
      ],
    },
  ],
};

export const ATTENDANCE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/hr/attendance", label: "Today", icon: Clock, end: true },
        { to: "/hr/attendance/approvals", label: "Approvals", icon: Inbox },
        { to: "/hr/attendance/shifts", label: "Shifts", icon: CalendarClock },
        { to: "/hr/attendance/roster", label: "Roster", icon: CalendarDays },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/hr/attendance/reports", label: "Reports", icon: BarChart3 },
        { to: "/hr/attendance/audit", label: "Audit", icon: Activity },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/hr/work-schedules", label: "Work schedules", icon: CalendarClock },
        { to: "/hr/attendance/devices", label: "Devices", icon: Smartphone },
        { to: "/hr/attendance/settings", label: "Settings", icon: Settings },
      ],
    },
  ],
};

/**
 * @deprecated Import `TIMESHEETS_NAV` from `@/apps/timesheets/nav` instead.
 * Re-exported here for one wave so unconverted callers keep building; the
 * Timesheets workspace is its own app and must not own a nav inside the HR
 * domain. See ADR 0005 (HR/payroll split) — Timesheets is independently
 * installable.
 */
export { TIMESHEETS_NAV } from "@/apps/timesheets/nav";

/**
 * Payroll workspace nav — folds the old internal `PayrollSidebar` into
 * the platform-wide WorkspaceNav contract so Payroll can shed its inner
 * SidebarProvider and run on the same shell as every other app.
 *
 * Groups mirror the legacy Operate / Compliance / Insights / Setup IA,
 * mapped to the platform's Operations / Setup vocabulary (Compliance
 * stays distinct — payroll-specific, no equivalent elsewhere).
 */
export const PAYROLL_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/hr/payroll", label: "Overview", icon: LayoutDashboard, end: true, permission: "viewPayroll" },
        { to: "/hr/payroll/readiness", label: "Readiness", icon: ClipboardCheck, permission: "viewPayroll" },
        { to: "/hr/payroll/work-entries", label: "Work entries", icon: Clock, permission: "viewPayroll" },
        { to: "/hr/payroll/runs", label: "Runs", icon: Calculator, permission: "viewPayroll" },
        { to: "/hr/payroll/control-center", label: "Control Center", icon: Layers, permission: "viewPayroll" },
        { to: "/hr/payroll/payslips", label: "Payslips", icon: FileText, permission: "viewPayroll" },
        { to: "/hr/payroll/payments", label: "Payments", icon: Banknote, permission: "viewPayroll" },
      ],
    },
    {
      label: "Compliance",
      items: [
        { to: "/hr/payroll/loans", label: "Loans", icon: Wallet, permission: "manageEmployeeLoans" },
        { to: "/hr/payroll/statutory-rules", label: "Statutory rules", icon: Shield, permission: "manageStatutoryRules" },
        { to: "/hr/payroll/legal-orders", label: "Legal orders", icon: Scale, permission: "managePayroll" },
        { to: "/hr/payroll/loan-skip-overrides", label: "Loan skip overrides", icon: Ban, permission: "runPayroll" },
        { to: "/hr/payroll/tax-certificates", label: "Tax certificates", icon: FileText, permission: "viewPayroll" },
        { to: "/hr/remittances", label: "Remittances", icon: Landmark, permission: "viewRemittances" },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/hr/payroll/reports", label: "Reports", icon: BarChart3, permission: "viewPayroll" },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/hr/payroll/setup", label: "Setup wizard", icon: Wand2, permission: "managePayroll" },
        {
          to: "/hr/payroll/configuration",
          label: "Configuration",
          icon: Settings,
          permission: "managePayroll",
          children: [
            { to: "/hr/payroll/configuration/schedules", label: "Schedules", icon: CalendarClock, permission: "managePayroll" },
            { to: "/hr/payroll/configuration/structures", label: "Salary structures", icon: Layers, permission: "managePayroll" },
            { to: "/hr/payroll/configuration/accounts", label: "GL account mapping", icon: Landmark, permission: "managePayroll" },
            { to: "/hr/payroll/configuration/loan-types", label: "Loan types", icon: Wallet, permission: "managePayroll" },
            { to: "/hr/payroll/configuration/work-entry-types", label: "Work entry types", icon: Tags, permission: "managePayroll" },
            { to: "/hr/payroll/configuration/input-types", label: "Variable input types", icon: Tags, permission: "managePayroll" },
            { to: "/hr/payroll/configuration/rule-types", label: "Rule type definitions", icon: Settings2, permission: "manageStatutoryRules" },
            { to: "/hr/payroll/configuration/custom-deductions", label: "Custom deductions", icon: Wallet, permission: "managePayroll" },
            { to: "/hr/payroll/configuration/templates", label: "Templates", icon: FileBox, permission: "managePayroll" },
            { to: "/hr/payroll/configuration/localization", label: "Localization", icon: Globe, permission: "managePayroll" },
          ],
        },
      ],
    },
  ],
};

export const TALENT_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/hr/talent/dashboard", label: "Overview", icon: LayoutDashboard, end: true },
        { to: "/hr/talent/goals", label: "Goals", icon: Target },
        { to: "/hr/talent/reviews", label: "Reviews", icon: ClipboardCheck },
        { to: "/hr/talent/cycles", label: "Performance cycles", icon: CalendarClock },
        { to: "/hr/talent/development", label: "Development plans", icon: GraduationCap },
        { to: "/hr/talent/learning", label: "Learning", icon: GraduationCap },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/hr/talent/analytics", label: "Analytics", icon: BarChart3 },
        { to: "/hr/talent/nine-box", label: "9-Box grid", icon: Layers },
        { to: "/hr/talent/succession", label: "Succession", icon: Network },
        { to: "/hr/talent/learning/reports", label: "Learning reports", icon: BarChart3 },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/hr/talent/competencies", label: "Competencies", icon: GraduationCap },
        { to: "/hr/talent/review-templates", label: "Review templates", icon: FileBox },
        { to: "/hr/talent/learning/paths", label: "Learning paths", icon: ListChecks },
        { to: "/hr/talent/quizzes", label: "Quiz authoring", icon: ClipboardList },
        { to: "/hr/talent/merit", label: "Merit & compensation", icon: Banknote },
        { to: "/hr/talent/settings", label: "Talent settings", icon: FileBox },
      ],
    },
  ],
};

export const RECRUITMENT_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/hr/recruitment", label: "Pipeline", icon: Briefcase, end: true },
      ],
    },
  ],
};

/**
 * Wave-1 sub-app surfaces (Contracts, Lifecycle, Reports, Document
 * compliance). These are NOT separate apps — they all mount the
 * `EMPLOYEES_APP` AppDefinition, so their link lists are folded into
 * `EMPLOYEES_NAV` below as collapsible children (ADR 0101). They stay
 * exported so each surface has exactly one source of truth for its links.
 * Scaffolds the new HR domain workspaces from the architecture plan.
 */

export const CONTRACTS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/hr/contracts", label: "Overview", icon: LayoutDashboard, end: true },
        { to: "/hr/contracts/all", label: "All contracts", icon: FileSignature },

        { to: "/hr/contracts/drafts", label: "Drafts", icon: FileText },
        { to: "/hr/contracts/pending", label: "Pending approval", icon: Inbox },
        { to: "/hr/contracts/active", label: "Active", icon: ShieldCheck },
        { to: "/hr/contracts/expiring", label: "Expiring", icon: AlertCircle },
        { to: "/hr/contracts/renewals", label: "Renewals", icon: Repeat },
        { to: "/hr/contracts/amendments", label: "Amendments", icon: FilePlus },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/hr/contracts/templates", label: "Templates", icon: FileBox },
        { to: "/hr/contracts/audit", label: "Audit", icon: Activity },
      ],
    },
  ],
};

export const LIFECYCLE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Pipelines",
      items: [
        { to: "/hr/lifecycle", label: "Overview", icon: GitBranch, end: true },
        { to: "/hr/lifecycle/onboarding", label: "Onboarding", icon: ClipboardList },
        { to: "/hr/lifecycle/probation", label: "Probation", icon: CalendarCheck },
        { to: "/hr/lifecycle/transfers", label: "Transfers", icon: Repeat },
        { to: "/hr/lifecycle/renewals", label: "Renewals", icon: FileSignature },
        { to: "/hr/lifecycle/offboarding", label: "Offboarding", icon: CalendarOff },
      ],
    },
    {
      label: "Records",
      items: [
        { to: "/hr/lifecycle/timeline", label: "All events", icon: History },
        { to: "/hr/lifecycle/archive", label: "Archive", icon: FileBox },
      ],
    },
  ],
};

export const HR_REPORTS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Library",
      items: [
        { to: "/hr/reports", label: "All questions", icon: Library, end: true },
        { to: "/hr/reports/workforce", label: "Workforce", icon: Users2 },
        { to: "/hr/reports/contracts", label: "Contracts", icon: FileSignature },
        { to: "/hr/reports/leave", label: "Leave", icon: CalendarOff },
        { to: "/hr/reports/payroll", label: "Payroll", icon: Banknote },
        { to: "/hr/reports/talent", label: "Talent", icon: TrendingUp },
        { to: "/hr/reports/org", label: "Organization", icon: NetIcon },
      ],
    },
    {
      label: "Saved",
      items: [
        { to: "/hr/reports/saved", label: "Saved views", icon: ListChecks },
        { to: "/hr/reports/scheduled", label: "Scheduled", icon: CalendarClock },
      ],
    },
  ],
};

export const DOCUMENT_COMPLIANCE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Compliance",
      items: [
        { to: "/hr/document-compliance/expiring", label: "Expiring soon", icon: AlertCircle, end: true },
        { to: "/hr/document-compliance/expired", label: "Expired", icon: Ban },
        { to: "/hr/document-compliance/unverified", label: "Unverified", icon: Shield },
      ],
    },
    {
      label: "Records",
      items: [
        { to: "/hr/document-compliance/all", label: "All documents", icon: FileBox },
      ],
    },
  ],
};

/**
 * `flattenNavItems` — collapse a WorkspaceNav's groups into a single flat
 * item list, for reuse as the `children` of a parent item inside another
 * workspace's nav. Group labels are dropped: a nested sub-tree in the
 * sidebar is already visually grouped by its parent.
 */
function flattenNavItems(nav: WorkspaceNav): WorkspaceNavItem[] {
  return nav.groups.flatMap((g) => g.items);
}

/**
 * EMPLOYEES_NAV — the single left rail for the Employees workspace.
 *
 * ADR 0101 (navigation replacement vs. expansion): navigation may only be
 * replaced when crossing an `AppDefinition`. Contracts, Lifecycle,
 * Recruitment, HR Reports and Document compliance all run under
 * `EMPLOYEES_APP` (same install gate, same entitlement, same breadcrumb
 * root), so they expand *inside* this nav as collapsible children instead
 * of swapping the sidebar out from under the user.
 *
 * Their link lists are not duplicated here — each surface's nav remains
 * the single source of truth and is folded in via `flattenNavItems`.
 */
export const EMPLOYEES_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Organization",
      items: [
        { to: "/hr/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/hr/employees", label: "Directory", icon: Users, end: true },
        { to: "/hr/employees/departments", label: "Departments", icon: Building2 },
        { to: "/hr/employees/positions", label: "Job positions", icon: Briefcase },
        { to: "/hr/employees/locations", label: "Work locations", icon: MapPin },
        { to: "/hr/employees/org-chart", label: "Org chart", icon: NetIcon },
      ],
    },
    {
      label: "People operations",
      items: [
        {
          to: "/hr/contracts",
          label: "Contracts & letters",
          icon: FileSignature,
          children: flattenNavItems(CONTRACTS_NAV),
        },
        {
          to: "/hr/lifecycle",
          label: "Lifecycle events",
          icon: History,
          children: flattenNavItems(LIFECYCLE_NAV),
        },
        { to: "/hr/recruitment", label: "Recruitment & offers", icon: Briefcase },
      ],
    },
    {
      label: "Insights",
      items: [
        {
          to: "/hr/reports",
          label: "HR reports",
          icon: Library,
          children: flattenNavItems(HR_REPORTS_NAV),
        },
      ],
    },
    {
      label: "Compliance",
      items: [
        {
          to: "/hr/document-compliance",
          label: "Document compliance",
          icon: ShieldCheck,
          children: flattenNavItems(DOCUMENT_COMPLIANCE_NAV),
        },
      ],
    },
    {
      label: "Setup",
      items: [
        {
          to: "/hr/configuration",
          label: "Configuration",
          icon: Settings,
          children: [
            { to: "/hr/configuration/onboarding-templates", label: "Onboarding templates", icon: ClipboardList },
            { to: "/hr/configuration/statutory-fields", label: "Statutory fields", icon: ShieldCheck },
            { to: "/hr/configuration/document-categories", label: "Document categories", icon: FileBox },
            { to: "/hr/configuration/policies", label: "HR policies", icon: ScrollText },
            { to: "/hr/configuration/maintenance", label: "Maintenance", icon: Wrench },
          ],
        },
      ],
    },
  ],
};
