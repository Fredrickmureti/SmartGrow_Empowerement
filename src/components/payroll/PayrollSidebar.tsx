/**
 * Payroll workspace sidebar.
 *
 * Replaces the previous monolithic Payroll page (3 tabs: Runs / Periods /
 * Analytics) with an Odoo-grade sidebar IA. Every section is a real route
 * gated by the right permission — see PayrollRoutes.tsx.
 *
 * Sections are grouped into:
 *   - Operate    (Overview, Readiness, Work Entries, Runs, Payslips, Payments)
 *   - Compliance (Loans, Statutory Rules, Remittances)
 *   - Insights   (Reports)
 *   - Setup      (Configuration → schedules / structures / rules / accounts / localization)
 *
 * Renders inside the existing HrAppShell (AppWorkspaceLayout), which
 * already provides the topbar + module switcher.
 */
import { Link, useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  ClipboardCheck,
  Clock,
  Calculator,
  FileText,
  Banknote,
  Wallet,
  Shield,
  Landmark,
  BarChart3,
  Settings,
  Wand2,
  Globe,
  Layers,
  Scale,
  Ban,
} from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import type { Permission } from "@/lib/permissions";

interface NavItem {
  title: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
  exact?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: "Operate",
    items: [
      { title: "Overview",     to: "/hr/payroll",              icon: LayoutDashboard, permission: "viewPayroll", exact: true },
      { title: "Readiness",    to: "/hr/payroll/readiness",    icon: ClipboardCheck,  permission: "viewPayroll" },
      { title: "Work Entries", to: "/hr/payroll/work-entries", icon: Clock,           permission: "viewPayroll" },
      { title: "Runs",         to: "/hr/payroll/runs",         icon: Calculator,      permission: "viewPayroll" },
      { title: "Control Center", to: "/hr/payroll/control-center", icon: Layers,    permission: "viewPayroll" },
      { title: "Payslips",     to: "/hr/payroll/payslips",     icon: FileText,        permission: "viewPayroll" },
      { title: "Payments",     to: "/hr/payroll/payments",     icon: Banknote,        permission: "viewPayroll" },
    ],
  },
  {
    label: "Compliance",
    items: [
      { title: "Loans",            to: "/hr/payroll/loans",            icon: Wallet,   permission: "manageEmployeeLoans" },
      { title: "Statutory Rules",  to: "/hr/payroll/statutory-rules",  icon: Shield,   permission: "manageStatutoryRules" },
      { title: "Garnishments",     to: "/hr/payroll/garnishments",     icon: Scale,    permission: "managePayroll" },
      { title: "Loan Skip Overrides", to: "/hr/payroll/loan-skip-overrides", icon: Ban, permission: "runPayroll" },
      { title: "Tax Certificates", to: "/hr/payroll/tax-certificates", icon: FileText, permission: "viewPayroll" },
      { title: "Remittances",      to: "/hr/remittances",              icon: Landmark, permission: "viewRemittances" },
    ],
  },
  {
    label: "Insights",
    items: [
      { title: "Reports", to: "/hr/payroll/reports", icon: BarChart3, permission: "viewPayroll" },
    ],
  },
  {
    label: "Setup",
    items: [
      { title: "Setup Wizard",     to: "/hr/payroll/setup",         icon: Wand2,    permission: "managePayroll" },
      { title: "Payroll Settings", to: "/hr/payroll/configuration", icon: Settings, permission: "managePayroll" },
    ],
  },
];

export function PayrollSidebar() {
  const { pathname } = useLocation();
  const { can } = usePermissions();

  const isActive = (to: string, exact?: boolean) =>
    exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Sidebar collapsible="icon" className="border-r top-16 h-[calc(100svh-4rem)]">
      <SidebarContent className="pt-4">
        {GROUPS.map((group) => {
          const visible = group.items.filter((i) => !i.permission || can(i.permission));
          if (!visible.length) return null;
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {visible.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={isActive(item.to, item.exact)}>
                        <Link to={item.to} className="flex items-center gap-2">
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
    </Sidebar>
  );
}
