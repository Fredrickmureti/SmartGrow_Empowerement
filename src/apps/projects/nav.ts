/**
 * Projects workspace navigation — drives the PlatformShell sidebar.
 */
import {
  LayoutGrid,
  CheckSquare,
  ListChecks,
  Flag,
  FileBox,
  Activity,
  FolderKanban,
  BarChart3,
  Settings,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const PROJECTS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/projects-app/overview", label: "Overview", icon: LayoutGrid, end: true },
        { to: "/projects-app/my-tasks", label: "My tasks", icon: CheckSquare },
        { to: "/projects-app/tasks", label: "All tasks", icon: ListChecks },
        { to: "/projects-app/milestones", label: "Milestones", icon: Flag },
        { to: "/projects-app/documents", label: "Documents", icon: FileBox },
        { to: "/projects-app/workload", label: "Workload", icon: Activity },
        { to: "/projects-app/list", label: "Projects", icon: FolderKanban },
      ],
    },
    {
      label: "Insights",
      items: [{ to: "/projects-app/reports", label: "Reports", icon: BarChart3 }],
    },
    {
      label: "Setup",
      items: [{ to: "/projects-app/configuration", label: "Configuration", icon: Settings }],
    },
  ],
};
