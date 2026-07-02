/**
 * POS workspace nav — Operations / Restaurant / Setup.
 *
 * Mirrors POS_APP.modules but laid out as a grouped sidebar so the
 * floor plan / kitchen / reservations group only shows when restaurant
 * mode is on (the modules are flagged `hidden` in the registry; this
 * nav file mirrors them visually — the registry remains the source of
 * truth for entitlement gating).
 */
import {
  Monitor,
  LayoutGrid,
  ChefHat,
  Calendar,
  BarChart3,
  CreditCard,
  Settings,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const POS_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/pos",         label: "POS Dashboard", icon: Monitor, end: true },
        { to: "/pos/reports", label: "POS Reports",   icon: BarChart3 },
      ],
    },
    {
      label: "Restaurant",
      items: [
        { to: "/pos/floor-plan", label: "Floor Plan",      icon: LayoutGrid },
        { to: "/pos/kitchen",    label: "Kitchen Display", icon: ChefHat },
        { to: "/pos/bookings",   label: "Reservations",    icon: Calendar },
      ],
    },
    {
      label: "Setup",
      items: [
        { to: "/pos/payment-terminals", label: "Payment Terminals", icon: CreditCard },
        { to: "/pos/settings",          label: "POS Settings",      icon: Settings },
      ],
    },
  ],
};
