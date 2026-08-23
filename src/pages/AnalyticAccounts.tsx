/**
 * Analytic Accounts — master data for the analytic (cost accounting) axes.
 *
 * This page deliberately shows NO balance column. Analytic balances are a
 * function of posted journal attribution over a period; a single unqualified
 * number on a master-data row would be a fabricated figure. Period balances
 * belong in the analytic reports, where a date range can be stated.
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  useAnalyticAccounts,
  type AnalyticAccount,
  type AnalyticStatus,
} from "@/hooks/useAnalyticAccounts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Search,
  Loader2,
  Target,
  Briefcase,
  Building2,
  Package,
  MoreHorizontal,
  Pencil,
  Archive,
  Trash2,
  FolderTree,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { normalizeError } from "@/services/resilience";
import { AnalyticAccountSheet } from "@/features/finance/analytic-accounts/AnalyticAccountSheet";
import { AnalyticGroupSheet } from "@/features/finance/analytic-accounts/AnalyticGroupSheet";

const PLAN_ICONS: Record<string, React.ElementType> = {
  cost_center: Target,
  project: Briefcase,
  department: Building2,
  product_line: Package,
};

const STATUS_STYLES: Record<AnalyticStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  restricted: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  archived: "bg-muted text-muted-foreground line-through",
};

export default function AnalyticAccounts() {
  const { plans, groups, accounts, isLoading, deleteAccount, archiveAccount } =
    useAnalyticAccounts();
  const { toast } = useToast();

  // URL-driven sheet state so the browser back button and deep links behave.
  const [searchParams, setSearchParams] = useSearchParams();
  const sheetKind = searchParams.get("sheet"); // "account" | "group" | null
  const sheetId = searchParams.get("id");

  const openAccountSheet = (id?: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("sheet", "account");
    if (id) next.set("id", id);
    else next.delete("id");
    setSearchParams(next, { replace: false });
  };
  const openGroupSheet = () => {
    const next = new URLSearchParams(searchParams);
    next.set("sheet", "group");
    next.delete("id");
    setSearchParams(next, { replace: false });
  };
  const closeSheet = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("sheet");
    next.delete("id");
    setSearchParams(next, { replace: false });
  };

  const editingAccount = useMemo<AnalyticAccount | null>(
    () =>
      sheetKind === "account" && sheetId
        ? accounts.find((a) => a.id === sheetId) ?? null
        : null,
    [sheetKind, sheetId, accounts],
  );

  const executeDelete = async (account: AnalyticAccount) => {
    try {
      await deleteAccount.mutateAsync(account.id);
      toast({ title: "Account deleted" });
    } catch (error) {
      toast({
        title: "Cannot delete this account",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const deleteConfirm = useConfirmDelete<AnalyticAccount>({ onConfirm: executeDelete });

  const searchQuery = searchParams.get("q") ?? "";
  const planFilter = searchParams.get("plan") ?? "all";
  const statusFilter = searchParams.get("status") ?? "all";
  const setParam = (key: string, v: string, clearWhen: string) => {
    const next = new URLSearchParams(searchParams);
    if (v && v !== clearWhen) next.set(key, v);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const filteredAccounts = accounts.filter((account) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !q ||
      account.name.toLowerCase().includes(q) ||
      (account.code?.toLowerCase().includes(q) ?? false);
    const matchesPlan = planFilter === "all" || account.plan_id === planFilter;
    const matchesStatus = statusFilter === "all" || account.status === statusFilter;
    return matchesSearch && matchesPlan && matchesStatus;
  });

  const planIcon = (planCode?: string | null) =>
    (planCode && PLAN_ICONS[planCode]) || FolderTree;

  const stats = {
    total: accounts.length,
    byPlan: plans.map((p) => ({
      ...p,
      icon: planIcon(p.code),
      count: accounts.filter((a) => a.plan_id === p.id).length,
    })),
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header flex-col sm:flex-row gap-4">
          <div>
            <h1 className="page-title">Analytic Accounts</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Cost and revenue dimensions — one value per plan on each posted line
            </p>
          </div>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            <Button variant="outline" onClick={openGroupSheet}>
              <Plus className="mr-2 h-4 w-4" />
              Add Group
            </Button>
            <Button onClick={() => openAccountSheet()}>
              <Plus className="mr-2 h-4 w-4" />
              Add Account
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="stats-grid grid-cols-2 sm:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total</CardTitle>
              <FolderTree className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          {stats.byPlan.slice(0, 4).map(({ id, name, icon: Icon, count }) => (
            <Card key={id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{name}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{count}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search accounts..."
              value={searchQuery}
              onChange={(e) => setParam("q", e.target.value, "")}
              className="pl-10 w-full"
            />
          </div>
          <Select value={planFilter} onValueChange={(v) => setParam("plan", v, "all")}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="All plans" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Plans</SelectItem>
              {plans.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setParam("status", v, "all")}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="restricted">Restricted</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredAccounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Target className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No analytic accounts</h3>
                <p className="text-muted-foreground">
                  Create cost centers, projects, or departments to track expenses.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Group</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAccounts.map((account) => {
                    const Icon = planIcon(account.plan?.code);
                    return (
                      <TableRow key={account.id}>
                        <TableCell className="font-mono">{account.code || "—"}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{account.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>{account.plan?.name || "—"}</TableCell>
                        <TableCell>{account.group?.name || "—"}</TableCell>
                        <TableCell>
                          <Badge className={STATUS_STYLES[account.status]}>
                            {account.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openAccountSheet(account.id)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              {account.status !== "archived" && (
                                <DropdownMenuItem
                                  onClick={() => archiveAccount.mutate(account.id)}
                                >
                                  <Archive className="mr-2 h-4 w-4" />
                                  Archive
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => deleteConfirm.requestDelete(account)}
                                className="text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          onConfirm={deleteConfirm.confirmDelete}
          title="Delete Analytic Account"
          description="Deleting is only possible while the account has never been used on a posted entry. Otherwise, archive it to keep its history intact."
          itemName={deleteConfirm.itemToDelete?.name}
          isLoading={deleteConfirm.isDeleting}
        />
      </div>

      {/* Enterprise UX: create/edit surfaces mounted on DetailSheet, driven by ?sheet=… */}
      <AnalyticAccountSheet
        open={sheetKind === "account"}
        onOpenChange={(o) => (o ? openAccountSheet(sheetId ?? undefined) : closeSheet())}
        account={editingAccount}
        groups={groups}
      />
      <AnalyticGroupSheet
        open={sheetKind === "group"}
        onOpenChange={(o) => (o ? openGroupSheet() : closeSheet())}
      />
    </>
  );
}
