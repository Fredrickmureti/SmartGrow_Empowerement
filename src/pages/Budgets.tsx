import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useBudgets, Budget } from "@/hooks/useBudgets";
import { useCurrency } from "@/hooks/useCurrency";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Loader2, Target, MoreHorizontal, Pencil, Trash2, Eye, CheckCircle,
  XCircle, Copy, FileText, Printer, FileSpreadsheet, Download,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { normalizeError } from "@/services/resilience";
import { CopyBudgetDetailSheet } from "@/features/finance/budgets/CopyBudgetDetailSheet";
import { buildBudgetScheduleExportConfig } from "@/features/finance/budgets/budgetScheduleExport";
import { useReportExportContext } from "@/contexts/ReportContext";
import {
  exportToCSV,
  exportToExcel,
  exportToPDF,
  printReportAsPdf,
} from "@/services/reports/ReportExportService";


export default function Budgets() {
  const { budgets, isLoading, deleteBudget, activateBudget, closeBudget } = useBudgets();
  const { formatCurrency } = useCurrency();
  const { periods } = useFiscalPeriods();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { allowed: canManageBudgets } = useFinancePermission("finance.manage_budgets");

  /**
   * Budget Schedule outputs straight from the list. These are read actions —
   * no manage permission required — and they reuse the exact server-build
   * config the detail page uses, so the artifact is identical either way.
   */
  const { enrichExportConfig } = useReportExportContext();
  const [exportingId, setExportingId] = useState<string | null>(null);

  const runBudgetExport = async (
    budget: Budget,
    format: "pdf" | "print" | "excel" | "csv",
  ) => {
    setExportingId(budget.id);
    try {
      const config = enrichExportConfig(buildBudgetScheduleExportConfig(budget));
      config.generatedAt = new Date();
      switch (format) {
        case "pdf":
          await exportToPDF(config);
          break;
        case "print":
          await printReportAsPdf(config);
          break;
        case "excel":
          await exportToExcel(config);
          break;
        case "csv":
          await exportToCSV(config);
          break;
      }
      toast({ title: "Budget schedule ready", description: budget.name });
    } catch (err) {
      toast({
        title: "Export failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setExportingId(null);
    }
  };



  // The Enterprise UX standard puts create/edit on dedicated routes
  // (`/finance/budgets/new`, `/finance/budgets/:id/edit`). The only
  // sheet left on this page is the confirm-style Copy sheet.
  //
  // Legacy `?sheet=budget|manage|item[&id]` deep-links land here from
  // bookmarks / audit trail links — we transparently redirect them to
  // the routed equivalents. `?sheet=copy&id=<uuid>` still opens the
  // Copy sheet inline.
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const sheetKind = searchParams.get("sheet");
  const sheetId = searchParams.get("id");

  useEffect(() => {
    if (sheetKind === "budget") {
      // Legacy: ?sheet=budget (create) or ?sheet=budget&id=<uuid> (edit).
      navigate(
        sheetId ? `/finance/budgets/${sheetId}/edit` : "/finance/budgets/new",
        { replace: true },
      );
    } else if (sheetKind === "manage" || sheetKind === "item") {
      if (sheetId) {
        navigate(`/finance/budgets/${sheetId}/edit`, { replace: true });
      } else {
        const next = new URLSearchParams(searchParams);
        next.delete("sheet");
        next.delete("id");
        setSearchParams(next, { replace: true });
      }
    }
  }, [sheetKind, sheetId, navigate, searchParams, setSearchParams]);

  const openCopy = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("sheet", "copy");
    next.set("id", id);
    setSearchParams(next, { replace: false });
  };
  const closeCopy = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("sheet");
    next.delete("id");
    setSearchParams(next, { replace: false });
  };

  const copySource = useMemo<Budget | null>(
    () =>
      sheetKind === "copy" && sheetId
        ? budgets.find((b) => b.id === sheetId) ?? null
        : null,
    [sheetKind, sheetId, budgets],
  );

  const isFiscalYearClosed = (year: number): boolean =>
    periods.some(
      (p) =>
        p.period_type === "year" &&
        p.status === "closed" &&
        p.name.includes(year.toString()),
    );

  const handleOpenBudget = (budget?: Budget) => {
    if (isReadOnly) {
      openUpgradeModal("budgets");
      return;
    }
    navigate(
      budget ? `/finance/budgets/${budget.id}/edit` : "/finance/budgets/new",
    );
  };

  const canTransitionTo = (
    budget: Budget,
    newStatus: string,
  ): { allowed: boolean; reason?: string } => {
    if (newStatus === budget.status)
      return { allowed: false, reason: "Already in this status" };
    if (newStatus === "active") {
      if (budget.status !== "draft")
        return { allowed: false, reason: "Can only activate from Draft status" };
      if (!budget.items || budget.items.length === 0)
        return {
          allowed: false,
          reason: "Budget must have at least one item before activating",
        };
      return { allowed: true };
    }
    if (newStatus === "closed") {
      if (budget.status !== "active")
        return { allowed: false, reason: "Can only close an Active budget" };
      return { allowed: true };
    }
    return { allowed: false, reason: "Unknown status" };
  };

  const handleStatusChange = async (budget: Budget, newStatus: string) => {
    const check = canTransitionTo(budget, newStatus);
    if (!check.allowed) {
      toast({
        title: "Cannot change status",
        description: check.reason,
        variant: "destructive",
      });
      return;
    }
    try {
      if (newStatus === "active") await activateBudget.mutateAsync(budget.id);
      else if (newStatus === "closed") await closeBudget.mutateAsync(budget.id);
      toast({
        title: `Budget ${newStatus === "active" ? "activated" : "closed"} successfully`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const executeDeleteBudget = async (budget: Budget) => {
    if (budget.status === "active" || budget.status === "closed") {
      toast({
        title: "Cannot delete",
        description: "Only Draft budgets can be deleted.",
        variant: "destructive",
      });
      return;
    }
    try {
      await deleteBudget.mutateAsync(budget.id);
      toast({ title: "Budget deleted successfully" });
    } catch (error) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const deleteConfirm = useConfirmDelete<Budget>({ onConfirm: executeDeleteBudget });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return <Badge className="bg-primary/10 text-primary">Active</Badge>;
      case "closed":
        return <Badge variant="secondary">Closed</Badge>;
      default:
        return <Badge variant="outline">Draft</Badge>;
    }
  };

  const stats = {
    total: budgets.length,
    active: budgets.filter((b) => b.status === "active").length,
    draft: budgets.filter((b) => b.status === "draft").length,
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title flex items-center gap-2">
                Budgets
                <FinanceScopeBadge />
              </h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                Plan and track your financial budgets
              </p>
            </div>
            <RefreshButton
              queryKeyPrefixes={[
                ["finance"] as const,
                ["budgets"] as const,
                queryKeys.reports.budgetVsActual(""),
              ]}
              tooltip="Refresh budgets"
            />
          </div>
          {canManageBudgets && (
            <PermissionGate permission="manageFinancials">
              <Button
                onClick={() => handleOpenBudget()}
                className="w-full sm:w-auto"
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Budget
              </Button>
            </PermissionGate>
          )}
        </div>

        {/* Stats */}
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Budgets</CardTitle>
              <Target className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active</CardTitle>
              <CheckCircle className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.active}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Draft</CardTitle>
              <XCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.draft}</div>
            </CardContent>
          </Card>
        </div>

        {/* Budgets Table */}
        <Card>
          <CardHeader>
            <CardTitle>All Budgets</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : budgets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Target className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No budgets yet</h3>
                <p className="text-muted-foreground">
                  Create your first budget to start planning.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Fiscal Year</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total Budgeted</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {budgets.map((budget) => (
                    <TableRow key={budget.id}>
                      <TableCell className="font-medium">{budget.name}</TableCell>
                      <TableCell>
                        {budget.fiscal_year}
                        {isFiscalYearClosed(budget.fiscal_year) && (
                          <Badge
                            variant="outline"
                            className="ml-2 text-[10px] border-destructive text-destructive"
                          >
                            FY Closed
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(budget.status)}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(budget.total_budgeted || 0)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                navigate(`/finance/budgets/${budget.id}/edit`)
                              }
                            >
                              <Eye className="mr-2 h-4 w-4" /> View & Manage
                            </DropdownMenuItem>
                            {canManageBudgets && (
                              <DropdownMenuItem
                                onClick={() => handleOpenBudget(budget)}
                              >
                                <Pencil className="mr-2 h-4 w-4" /> Edit
                              </DropdownMenuItem>
                            )}
                            {canManageBudgets && (
                              <DropdownMenuItem
                                onClick={() => openCopy(budget.id)}
                              >
                                <Copy className="mr-2 h-4 w-4" /> Copy to Next Year
                              </DropdownMenuItem>
                            )}
                            {canManageBudgets && <DropdownMenuSeparator />}
                            {canManageBudgets && budget.status === "draft" && (
                              <DropdownMenuItem
                                onClick={() => handleStatusChange(budget, "active")}
                              >
                                <CheckCircle className="mr-2 h-4 w-4" /> Activate
                              </DropdownMenuItem>
                            )}
                            {canManageBudgets && budget.status === "active" && (
                              <DropdownMenuItem
                                onClick={() => handleStatusChange(budget, "closed")}
                              >
                                <XCircle className="mr-2 h-4 w-4" /> Close Budget
                              </DropdownMenuItem>
                            )}
                            {canManageBudgets && budget.status === "draft" && (
                              <DropdownMenuSeparator />
                            )}
                            {canManageBudgets && budget.status === "draft" && (
                              <DropdownMenuItem
                                onClick={() => deleteConfirm.requestDelete(budget)}
                                className="text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" /> Delete
                              </DropdownMenuItem>
                            )}
                            {!canManageBudgets && (
                              <DropdownMenuItem disabled>
                                Read-only (lacks finance.manage_budgets)
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Budget"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />
      </div>

      {/*
       * Enterprise UX: create/edit live at /finance/budgets/new and
       * /finance/budgets/:id/edit on `RecordFormShell`. The only sheet
       * that remains here is the confirm-style Copy sheet (2 fields).
       */}
      <CopyBudgetDetailSheet
        open={sheetKind === "copy"}
        onOpenChange={(o) => (o ? openCopy(sheetId ?? "") : closeCopy())}
        source={copySource}
      />
    </>
  );
}
