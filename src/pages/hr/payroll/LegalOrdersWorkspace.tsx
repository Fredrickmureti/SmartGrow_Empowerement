/**
 * Legal Orders operator workspace shell — Phase 4.
 *
 * A single tabbed shell that unifies the four surfaces the operator
 * needs to run garnishments end-to-end:
 *
 *   Tasks         → action inbox (approvals, unlinked recipients, past-due)
 *   Orders        → per-employee legal-order register (existing page)
 *   Recipients    → third-party master data + outstanding balances
 *   Remittances   → aggregated payout batches per authority / method
 *
 * Route boundaries stay the same — the shell only adds the top nav
 * bar so bookmarks and deep links keep working.
 */
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ClipboardList, Scale, Users, Banknote, Layers, PackageCheck, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/hr/payroll/legal-orders", label: "Tasks", icon: ClipboardList, end: true },
  { to: "/hr/payroll/legal-orders/orders", label: "Orders", icon: Scale, end: false },
  { to: "/hr/payroll/legal-orders/packs", label: "Packs", icon: Layers, end: false },
  { to: "/hr/payroll/legal-orders/recipients", label: "Recipients", icon: Users, end: false },
  { to: "/hr/payroll/legal-orders/remittance-batch", label: "Remittances", icon: Banknote, end: false },
  { to: "/hr/payroll/legal-orders/batches", label: "Batches", icon: PackageCheck, end: false },
  { to: "/hr/payroll/legal-orders/audit", label: "Audit", icon: Activity, end: false },
];

export default function LegalOrdersWorkspace() {
  const { pathname } = useLocation();
  return (
    <div className="flex flex-col">
      <header className="border-b bg-background">
        <div className="px-6 pt-6">
          <h1 className="text-2xl font-semibold">Legal Orders</h1>
          <p className="text-sm text-muted-foreground">
            Court orders, garnishments, statutory attachments and their
            recipients — one workspace from intake to remittance.
          </p>
        </div>
        <nav
          className="px-6 mt-4 flex gap-1 border-b -mb-px"
          aria-label="Legal orders sections"
        >
          {TABS.map(({ to, label, icon: Icon, end }) => {
            const active = end
              ? pathname === to
              : pathname === to || pathname.startsWith(to + "/");
            return (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={cn(
                  "inline-flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px transition-colors",
                  active
                    ? "border-primary text-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            );
          })}
        </nav>
      </header>
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );
}
