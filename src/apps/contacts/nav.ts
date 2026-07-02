/**
 * Contacts workspace navigation — drives the PlatformShell sidebar.
 */
import { Users, UserCheck, Truck, Building2 } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const CONTACTS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/contacts-app", label: "All contacts", icon: Users, end: true },
        { to: "/contacts-app/customers", label: "Customers", icon: UserCheck },
        { to: "/contacts-app/vendors", label: "Vendors", icon: Truck },
        { to: "/contacts-app/companies", label: "Companies", icon: Building2 },
      ],
    },
  ],
};
