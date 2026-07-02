/**
 * DashboardCommandStrip — action-oriented chips at the top of the dashboard.
 *
 * Turns the dashboard from "what happened" into "what should I do" by
 * surfacing aggregate signals (overdue invoices, bills due soon, low stock,
 * unreconciled bank transactions) as clickable deep links that preserve
 * the active dashboard scope (branch / consolidated / business).
 *
 * Each chip only renders when (a) its module is installed + permitted by
 * the parent, and (b) the count is non-zero. The whole strip is hidden
 * when nothing needs attention so the dashboard never shows an empty
 * "all clear" bar that just adds noise.
 */
import { useNavigate } from "react-router-dom";
import { AlertTriangle, FileWarning, Package, Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardActionItems } from "@/hooks/useDashboardActionItems";
import { useDashboardScope } from "@/hooks/useDashboardScope";
import { withScope } from "@/lib/withScope";
import { cn } from "@/lib/utils";

interface Props {
  hasSales: boolean;
  hasPurchases: boolean;
  hasInventory: boolean;
  hasFinance: boolean;
}

interface Chip {
  key: string;
  count: number;
  label: string;
  tone: "warning" | "destructive" | "info";
  icon: React.ReactNode;
  to: string;
}

export function DashboardCommandStrip({ hasSales, hasPurchases, hasInventory, hasFinance }: Props) {
  const navigate = useNavigate();
  const scope = useDashboardScope();
  const { data, isLoading } = useDashboardActionItems({ hasSales, hasPurchases, hasInventory, hasFinance });

  if (isLoading) {
    return (
      <div className="flex gap-2 overflow-x-auto pb-1">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-40 flex-shrink-0 rounded-md" />
        ))}
      </div>
    );
  }

  if (!data) return null;

  const chips: Chip[] = [];

  if (hasSales && data.overdueInvoices > 0) {
    chips.push({
      key: "overdue-invoices",
      count: data.overdueInvoices,
      label: `${data.overdueInvoices} overdue invoice${data.overdueInvoices === 1 ? "" : "s"}`,
      tone: "destructive",
      icon: <FileWarning className="h-4 w-4" />,
      to: withScope("/sales/invoices?filter=overdue", scope),
    });
  }
  if (hasPurchases && data.billsDueSoon > 0) {
    chips.push({
      key: "bills-due",
      count: data.billsDueSoon,
      label: `${data.billsDueSoon} bill${data.billsDueSoon === 1 ? "" : "s"} due this week`,
      tone: "warning",
      icon: <AlertTriangle className="h-4 w-4" />,
      to: withScope("/purchases/bills?filter=due_soon", scope),
    });
  }
  if (hasInventory && data.lowStock > 0) {
    chips.push({
      key: "low-stock",
      count: data.lowStock,
      label: `${data.lowStock} item${data.lowStock === 1 ? "" : "s"} low on stock`,
      tone: "warning",
      icon: <Package className="h-4 w-4" />,
      to: withScope("/inventory-app/stock?filter=low", scope),
    });
  }
  if (hasFinance && data.unreconciledTxns > 0) {
    chips.push({
      key: "unreconciled",
      count: data.unreconciledTxns,
      label: `${data.unreconciledTxns} unreconciled txn${data.unreconciledTxns === 1 ? "" : "s"}`,
      tone: "info",
      icon: <Wallet className="h-4 w-4" />,
      to: withScope("/finance/banking?filter=unreconciled", scope),
    });
  }

  if (chips.length === 0) return null;

  return (
    <Card className="p-2 sm:p-3">
      <div className="flex items-center gap-2 overflow-x-auto">
        <span className="text-xs font-medium text-muted-foreground px-2 hidden sm:inline whitespace-nowrap">
          Needs attention
        </span>
        <div className="flex gap-2 flex-wrap">
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => navigate(chip.to)}
              className={cn(
                "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                chip.tone === "destructive" && "border-destructive/40 text-destructive",
                chip.tone === "warning" && "border-warning/40 text-warning",
                chip.tone === "info" && "border-border text-foreground",
              )}
            >
              {chip.icon}
              <span>{chip.label}</span>
              <Badge variant="secondary" className="ml-1">{chip.count}</Badge>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
