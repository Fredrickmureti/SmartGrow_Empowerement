/**
 * Contacts workspace navigation — drives the PlatformShell sidebar.
 *
 * The supplier surface deliberately lives in Purchases, not here: a supplier
 * is a procurement *role* over a party (ADR-0079). Contacts owns party-level
 * identity only, so a "Vendors" list here would bypass the supplier lifecycle.
 */
import { Users, UserCheck, Building2 } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const CONTACTS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/contacts-app", label: "All contacts", icon: Users, end: true },
        { to: "/contacts-app/customers", label: "Customers", icon: UserCheck },
        { to: "/contacts-app/companies", label: "Companies", icon: Building2 },
      ],
    },
  ],
};
