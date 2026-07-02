/**
 * DashboardCreateBar — verb-led "Create" affordances at the top of the
 * dashboard. Surfaces the highest-frequency transactional actions so a
 * user lands on the dashboard and can start work in one click, instead
 * of hunting through sidebars. Each button is install + permission
 * gated; renders nothing if no actions are available.
 *
 * Routes use the shared `?action=create` query convention already
 * honored by Invoices.tsx, Expenses.tsx, Contacts.tsx, Banking.tsx
 * (see GlobalCreateMenu for the source of truth).
 */
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FileText, Receipt, UserPlus, Landmark, ShoppingBag, Plus } from "lucide-react";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { usePermissions } from "@/hooks/usePermissions";

interface CreateAction {
  label: string;
  icon: React.ElementType;
  href: string;
  variant?: "default" | "outline";
}

export function DashboardCreateBar() {
  const { isInstalled } = useInstalledApps();
  const perms = usePermissions();
  const navigate = useNavigate();

  const actions: CreateAction[] = [];

  if (isInstalled("sales") && perms.canManageSales) {
    actions.push({ label: "Create Invoice", icon: FileText, href: "/sales/invoices?action=create", variant: "default" });
  }
  if (isInstalled("purchases") && (perms.canManagePurchases || perms.canManageFinancials)) {
    actions.push({ label: "Record Expense", icon: Receipt, href: "/purchases/expenses?action=create", variant: "outline" });
    actions.push({ label: "New Bill", icon: ShoppingBag, href: "/purchases/bills?action=create", variant: "outline" });
  }
  if (isInstalled("contacts") && perms.canManageContacts) {
    actions.push({ label: "Add Customer", icon: UserPlus, href: "/contacts-app/customers?action=create", variant: "outline" });
  }
  if (isInstalled("finance") && perms.canManageFinancials) {
    actions.push({ label: "Add Bank Account", icon: Landmark, href: "/finance/banking?action=create", variant: "outline" });
  }

  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 sm:p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1">
        <Plus className="h-3.5 w-3.5" />
        Create
      </div>
      {actions.map((a) => {
        const Icon = a.icon;
        return (
          <Button
            key={a.label}
            size="sm"
            variant={a.variant ?? "outline"}
            onClick={() => navigate(a.href)}
            className="h-8"
          >
            <Icon className="mr-1.5 h-3.5 w-3.5" />
            {a.label}
          </Button>
        );
      })}
    </div>
  );
}
