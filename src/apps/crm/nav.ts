/**
 * CRM workspace navigation — drives the PlatformShell sidebar.
 */
import { LayoutGrid, GitBranch, CalendarCheck, Users, Target } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const CRM_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/crm-app/dashboard", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/crm-app/leads", label: "Leads", icon: Target },
        { to: "/crm-app/pipeline", label: "Pipeline", icon: GitBranch },
        { to: "/crm-app/activities", label: "Activities", icon: CalendarCheck },
        { to: "/crm-app/contacts", label: "Contacts", icon: Users },
      ],
    },
  ],
};
