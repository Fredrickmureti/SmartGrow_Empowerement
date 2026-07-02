/**
 * TIMESHEETS_NAV — workspace nav for the Timesheets app.
 *
 * Moved out of `apps/hr/shared/navs.ts` so the Timesheets app no longer
 * imports across the HR app boundary. The HR file re-exports this
 * symbol as a one-wave deprecation shim; new callers MUST import from
 * here.
 */
import {
  Inbox,
  Users,
  FolderKanban,
  BarChart3,
  Settings,
} from "lucide-react";

import type { WorkspaceNav } from "@/components/layout/shell/types";

export const TIMESHEETS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/timesheets", label: "Approvals", icon: Inbox, end: true },
        { to: "/timesheets/team", label: "Team", icon: Users },
        { to: "/timesheets/by-project", label: "By project", icon: FolderKanban },
      ],
    },
    {
      label: "Insights",
      items: [{ to: "/timesheets/reports", label: "Reports", icon: BarChart3 }],
    },
    {
      label: "Setup",
      items: [{ to: "/timesheets/settings", label: "Settings", icon: Settings }],
    },
  ],
};
