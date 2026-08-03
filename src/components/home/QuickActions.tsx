/**
 * QuickActions Component
 * 
 * QuickBooks-inspired "Business at a Glance" quick action tiles.
 * Permission-aware and app-install-gated.
 */

import { Link } from "react-router-dom";
import {
  Calculator,
  Receipt,
  CreditCard,
  Users,
  Clock,
  FileText,
  Landmark,
  ShoppingCart,
  BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { usePermissions } from "@/hooks/usePermissions";

interface QuickActionItem {
  label: string;
  description: string;
  icon: React.ElementType;
  href: string;
  color: string;
}

export function QuickActions() {
  const { isInstalled } = useInstalledApps();
  const permissions = usePermissions();

  const actions: QuickActionItem[] = [];

  if (isInstalled("finance") && (permissions.canViewFinancials || permissions.canManageFinancials)) {
    actions.push({
      label: "Accounting",
      description: "Chart of accounts, journals",
      icon: Calculator,
      href: "/finance",
      color: "hsl(142, 76%, 36%)",
    });
  }

  if (isInstalled("purchases") && (permissions.canViewPurchases || permissions.canManagePurchases || permissions.canManageFinancials)) {
    actions.push({
      label: "Expenses & Pay Bills",
      description: "Bills, payments, purchase orders",
      icon: Receipt,
      href: "/purchases/bills",
      color: "hsl(25, 95%, 53%)",
    });
  }

  if (isInstalled("sales") && (permissions.canViewSales || permissions.canManageSales)) {
    actions.push({
      label: "Sales & Get Paid",
      description: "Invoices, payments, quotes",
      icon: CreditCard,
      href: "/sales/invoices",
      color: "hsl(217, 91%, 60%)",
    });
  }

  if (isInstalled("contacts") && (permissions.canViewContacts || permissions.canManageContacts)) {
    actions.push({
      label: "Customers",
      description: "Manage contacts & companies",
      icon: Users,
      href: "/contacts-app/customers",
      color: "hsl(262, 83%, 58%)",
    });
  }

  if (isInstalled("hr") && (permissions.canViewPayroll || permissions.canManagePayroll || permissions.canRunPayroll || permissions.canApprovePayroll || permissions.canPostPayrollGL || permissions.canPayPayroll)) {
    actions.push({
      label: "Team",
      description: "Employees, payroll, leave",
      icon: Clock,
      href: "/hr",
      color: "hsl(45, 93%, 47%)",
    });
  }

  if (isInstalled("finance") && permissions.canViewFinancials) {
    actions.push({
      label: "Banking",
      description: "Bank feeds & reconciliation",
      icon: Landmark,
      href: "/finance/banking",
      color: "hsl(173, 80%, 40%)",
    });
  }

  if (isInstalled("reports") && permissions.canViewReports) {
    actions.push({
      label: "Reports",
      description: "P&L, balance sheet, tax",
      icon: BarChart3,
      href: "/finance/reports",
      color: "hsl(340, 82%, 52%)",
    });
  }

  if (actions.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
        Quick Actions
      </h2>
      <div className="grid grid-cols-1 @[22rem]/page:grid-cols-2 @[36rem]/page:grid-cols-3 @[52rem]/page:grid-cols-4 gap-2 sm:gap-3">
        {actions.map((action) => (
          <Link
            key={action.label}
            to={action.href}
            className={cn(
              "group flex flex-col gap-1.5 rounded-xl border bg-card p-3 sm:p-4 transition-all",
              "hover:shadow-md hover:border-primary/20 hover:-translate-y-0.5"
            )}
          >
            <div
              className="h-8 w-8 rounded-lg flex items-center justify-center transition-transform group-hover:scale-110"
              style={{ backgroundColor: `${action.color}15`, color: action.color }}
            >
              <action.icon className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">{action.label}</p>
              <p className="text-xs text-muted-foreground leading-tight mt-0.5 hidden sm:block">
                {action.description}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
