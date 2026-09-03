/**
 * Launcher quick actions — microfinance operations only.
 *
 * Permission-gated shortcuts into the lending, finance and reporting
 * workspaces. ERP shortcuts (sales invoices, purchase bills, inventory,
 * payroll) were removed with those domains.
 */

import { Link } from "react-router-dom";
import {
  BarChart3,
  Calculator,
  ClipboardList,
  HandCoins,
  Landmark,
  Target,
  Users,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/usePermissions";

interface QuickActionItem {
  label: string;
  description: string;
  icon: React.ElementType;
  href: string;
  color: string;
}

export function QuickActions() {
  const { can, canViewFinancials, canManageFinancials, canViewReports } = usePermissions();

  const actions: QuickActionItem[] = [];

  if (can("viewClients")) {
    actions.push({
      label: "Clients",
      description: "Members, groups & KYC",
      icon: Users,
      href: "/lending",
      color: "hsl(262, 83%, 58%)",
    });
  }

  if (can("viewApplications")) {
    actions.push({
      label: "Applications",
      description: "Apply, assess, decide",
      icon: ClipboardList,
      href: "/lending/applications",
      color: "hsl(217, 91%, 60%)",
    });
  }

  if (can("viewLoans")) {
    actions.push({
      label: "Loans",
      description: "Schedules & disbursement",
      icon: HandCoins,
      href: "/lending/loans",
      color: "hsl(142, 76%, 36%)",
    });
  }

  if (can("recordRepayments")) {
    actions.push({
      label: "Repayments",
      description: "Receipts & collection banking",
      icon: Wallet,
      href: "/lending/repayments",
      color: "hsl(173, 80%, 40%)",
    });
  }

  if (can("viewCollections")) {
    actions.push({
      label: "Collections",
      description: "Arrears follow-up & promises",
      icon: Target,
      href: "/lending/collections",
      color: "hsl(25, 95%, 53%)",
    });
  }

  if (canViewFinancials || canManageFinancials) {
    actions.push(
      {
        label: "Accounting",
        description: "Chart of accounts, journals",
        icon: Calculator,
        href: "/finance",
        color: "hsl(45, 93%, 47%)",
      },
      {
        label: "Banking",
        description: "Bank accounts & reconciliation",
        icon: Landmark,
        href: "/finance/banking",
        color: "hsl(199, 89%, 48%)",
      },
    );
  }

  if (canViewReports || can("viewLendingReports")) {
    actions.push({
      label: "Reports",
      description: "Portfolio, arrears, collections",
      icon: BarChart3,
      href: "/lending/reports/portfolio",
      color: "hsl(340, 82%, 52%)",
    });
  }

  if (actions.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Quick Actions
      </h2>
      <div className="grid grid-cols-1 gap-2 @[22rem]/page:grid-cols-2 @[36rem]/page:grid-cols-3 @[52rem]/page:grid-cols-4 sm:gap-3">
        {actions.map((action) => (
          <Link
            key={action.label}
            to={action.href}
            className={cn(
              "group flex flex-col gap-1.5 rounded-xl border bg-card p-3 transition-all sm:p-4",
              "hover:-translate-y-0.5 hover:border-primary/20 hover:shadow-md",
            )}
          >
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-transform group-hover:scale-110"
              style={{ backgroundColor: `${action.color}15`, color: action.color }}
            >
              <action.icon className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">{action.label}</p>
              <p className="mt-0.5 hidden text-xs leading-tight text-muted-foreground sm:block">
                {action.description}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
