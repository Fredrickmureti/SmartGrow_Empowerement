/**
 * SMS workspace navigation — drives the PlatformShell sidebar.
 */
import {
  MessageSquare,
  FileText,
  Zap,
  Users,
  ScrollText,
  Ban,
  Settings,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const SMS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/sms/log", label: "Message log", icon: ScrollText },
        { to: "/sms/recipient-groups", label: "Recipient groups", icon: Users },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/sms/templates", label: "Templates", icon: FileText },
        { to: "/sms/rules", label: "Event rules", icon: Zap },
        { to: "/sms/opt-outs", label: "Opt-outs", icon: Ban },
        { to: "/sms/settings", label: "Settings", icon: Settings },
      ],
    },
  ],
};
