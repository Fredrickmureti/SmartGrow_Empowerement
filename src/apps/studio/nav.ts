/**
 * Studio workspace navigation — drives the PlatformShell sidebar.
 *
 * Studio is a customization toolkit; the modules are equally weighted
 * builder surfaces, so they all live under a single Operations group.
 */
import {
  Wand2,
  LayoutGrid,
  Zap,
  BarChart3,
  Shield,
  FileText,
  CalendarClock,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const STUDIO_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/studio/fields", label: "Fields", icon: Wand2 },
        { to: "/studio/forms", label: "Forms", icon: LayoutGrid },
        { to: "/studio/views", label: "Views", icon: BarChart3 },
        { to: "/studio/automations", label: "Automations", icon: Zap },
        { to: "/studio/approvals", label: "Approvals", icon: Shield },
        { to: "/studio/reports", label: "Reports", icon: FileText },
        { to: "/studio/scheduling", label: "Scheduling", icon: CalendarClock },
      ],
    },
  ],
};
