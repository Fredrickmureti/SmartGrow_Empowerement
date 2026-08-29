/**
 * Workspace navigation for the HR domain.
 *
 * The microfinance platform ships a single HR workspace — Employees.
 * Payroll, Time Off, Attendance, Timesheets, Talent, Recruitment,
 * Contracts, Lifecycle, HR Reports and Document Compliance navs were
 * removed with their surfaces; do not re-add links here without the
 * matching routes.
 */
import {
  LayoutGrid,
  Users,
  Building2,
  Briefcase,
  MapPin,
  Settings,
  ClipboardList,
  ShieldCheck,
  FileBox,
  ScrollText,
  Wrench,
  Network as NetIcon,
} from "lucide-react";

import type { WorkspaceNav } from "@/components/layout/shell/types";

/**
 * EMPLOYEES_NAV — the single left rail for the Employees workspace.
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
