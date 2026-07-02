import { useState, useMemo } from "react";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useBudgets, Budget, BudgetItem } from "@/hooks/useBudgets";
import { useBudgetVsActual } from "@/hooks/useBudgetVsActual";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Loader2, Target, MoreHorizontal, Pencil, Trash2, Eye, CheckCircle,
  XCircle, Copy, AlertTriangle, TrendingUp, TrendingDown,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell,
} from "recharts";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { normalizeError } from "@/services/resilience";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export default function Budgets() {
  const { budgets, isLoading, createBudget, updateBudget, deleteBudget, upsertBudgetItem, activateBudget, closeBudget } = useBudgets();
  const { accounts } = useAccounts();
  const { formatCurrency } = useCurrency();
  const { periods, isDateLocked } = useFiscalPeriods();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { allowed: canManageBudgets } = useFinancePermission("finance.manage_budgets");
  const [selectedBudgetId, setSelectedBudgetId] = useState<string | undefined>();
  const { storedActuals, calculateActuals, getChartData, selectedBudget: bvaBudget, getVarianceReport } = useBudgetVsActual(selectedBudgetId);

  const [showBudgetDialog, setShowBudgetDialog] = useState(false);
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [selectedBudget, setSelectedBudget] = useState<Budget | null>(null);
  const [copySourceBudget, setCopySourceBudget] = useState<Budget | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const currentYear = new Date().getFullYear();

  const [budgetForm, setBudgetForm] = useState({
    name: "",
    description: "",
    fiscal_year: currentYear,
    status: "draft" as string,
  });

  const [itemForm, setItemForm] = useState({
    account_id: "",
    period_month: 1,
    budgeted_amount: 0,
    notes: "",
  });

  const [copyTargetYear, setCopyTargetYear] = useState(currentYear + 1);

  // Check if a fiscal year has a closed fiscal period
  const isFiscalYearClosed = (year: number): boolean => {
    return periods.some(p =>
      p.period_type === "year" &&
      p.status === "closed" &&
      p.name.includes(year.toString())
    );
  };

  const resetBudgetForm = () => {
    setBudgetForm({ name: "", description: "", fiscal_year: currentYear, status: "draft" });
    setEditingBudget(null);
  };

  const resetItemForm = () => {
    setItemForm({ account_id: "", period_month: 1, budgeted_amount: 0, notes: "" });
  };

  const handleOpenBudgetDialog = (budget?: Budget) => {
    if (isReadOnly) { openUpgradeModal("budgets"); return; }
    if (budget) {
      setEditingBudget(budget);
      setBudgetForm({
        name: budget.name,
        description: budget.description || "",
        fiscal_year: budget.fiscal_year,
        status: budget.status,
      });
    } else {
      resetBudgetForm();
    }
    setShowBudgetDialog(true);
  };

  const handleOpenItemDialog = () => { resetItemForm(); setShowItemDialog(true); };

  const handleViewBudget = (budget: Budget) => {
    setSelectedBudget(budget);
    setSelectedBudgetId(budget.id);
    setShowViewDialog(true);
  };

  // Status transition validation
  const canTransitionTo = (budget: Budget, newStatus: string): { allowed: boolean; reason?: string } => {
    if (newStatus === budget.status) return { allowed: false, reason: "Already in this status" };

    if (newStatus === "active") {
      if (budget.status !== "draft") return { allowed: false, reason: "Can only activate from Draft status" };
      if (!budget.items || budget.items.length === 0) return { allowed: false, reason: "Budget must have at least one item before activating" };
      return { allowed: true };
    }
    if (newStatus === "closed") {
      if (budget.status !== "active") return { allowed: false, reason: "Can only close an Active budget" };
      return { allowed: true };
    }
    if (newStatus === "draft") {
      if (budget.status === "closed") return { allowed: false, reason: "Cannot revert a Closed budget to Draft" };
      return { allowed: false, reason: "Invalid transition" };
    }
    return { allowed: false, reason: "Unknown status" };
  };

  const handleStatusChange = async (budget: Budget, newStatus: string) => {
    const check = canTransitionTo(budget, newStatus);
    if (!check.allowed) {
      toast({ title: "Cannot change status", description: check.reason, variant: "destructive" });
      return;
    }
    try {
      if (newStatus === "active") await activateBudget.mutateAsync(budget.id);
      else if (newStatus === "closed") await closeBudget.mutateAsync(budget.id);
      toast({ title: `Budget ${newStatus === "active" ? "activated" : "closed"} successfully` });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  // Copy prior year budget
  const handleCopyBudget = async () => {
    if (!copySourceBudget) return;
    setIsSubmitting(true);
    try {
      const newName = `${copySourceBudget.name} (Copy ${copyTargetYear})`;
      const items = copySourceBudget.items?.map(item => ({
        account_id: item.account_id,
        period_month: item.period_month,
        budgeted_amount: item.budgeted_amount,
        notes: item.notes || undefined,
      }));
      await createBudget.mutateAsync({
        name: newName,
        fiscal_year: copyTargetYear,
        description: `Copied from ${copySourceBudget.name} (FY ${copySourceBudget.fiscal_year})`,
        items,
      });
      toast({ title: "Budget copied successfully" });
      setShowCopyDialog(false);
      setCopySourceBudget(null);
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (editingBudget) {
        // Block edits to budgets in closed fiscal years
        if (isFiscalYearClosed(budgetForm.fiscal_year)) {
          toast({ title: "Cannot edit", description: "This fiscal year is closed.", variant: "destructive" });
          return;
        }
        await updateBudget.mutateAsync({ id: editingBudget.id, ...budgetForm });
        toast({ title: "Budget updated successfully" });
      } else {
        await createBudget.mutateAsync(budgetForm);
        toast({ title: "Budget created successfully" });
      }
      setShowBudgetDialog(false);
      resetBudgetForm();
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBudget) return;

    // Validate: cannot add items to closed budget
    if (selectedBudget.status === "closed") {
      toast({ title: "Cannot add items", description: "This budget is closed.", variant: "destructive" });
      return;
    }

    // Validate: check if the month's fiscal period is closed
    const monthDate = `${selectedBudget.fiscal_year}-${String(itemForm.period_month).padStart(2, "0")}-15`;
    if (isDateLocked(monthDate)) {
      toast({ title: "Period locked", description: `The fiscal period for ${MONTHS[itemForm.period_month - 1]} ${selectedBudget.fiscal_year} is closed.`, variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      await upsertBudgetItem.mutateAsync({
        budget_id: selectedBudget.id,
        account_id: itemForm.account_id,
        period_month: itemForm.period_month,
        budgeted_amount: itemForm.budgeted_amount,
        notes: itemForm.notes,
      });
      toast({ title: "Budget item saved successfully" });
      setShowItemDialog(false);
      resetItemForm();
      const updatedBudget = budgets.find(b => b.id === selectedBudget.id);
      if (updatedBudget) setSelectedBudget(updatedBudget);
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const executeDeleteBudget = async (budget: Budget) => {
    if (budget.status === "active" || budget.status === "closed") {
      toast({ title: "Cannot delete", description: "Only Draft budgets can be deleted.", variant: "destructive" });
      return;
    }
    try {
      await deleteBudget.mutateAsync(budget.id);
      toast({ title: "Budget deleted successfully" });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const deleteConfirm = useConfirmDelete<Budget>({ onConfirm: executeDeleteBudget });
  const handleDeleteBudget = (budget: Budget) => { deleteConfirm.requestDelete(budget); };

  const getSelectedBudgetItems = (): BudgetItem[] => selectedBudget?.items || [];

  const getBudgetTotalByMonth = () => {
    if (!selectedBudget) return [];
    const chartData = bvaBudget ? getChartData(selectedBudget) : null;
    if (chartData) return chartData;

    const items = getSelectedBudgetItems();
    return MONTHS.map((month, index) => {
      const monthItems = items.filter(item => item.period_month === index + 1);
      const total = monthItems.reduce((sum, item) => sum + item.budgeted_amount, 0);
      const monthActuals = storedActuals.filter(a => a.period_month === index + 1);
      const actual = monthActuals.reduce((sum, a) => sum + a.actual_amount, 0);
      return { month: month.substring(0, 3), budgeted: total, actual, variance: total - actual };
    });
  };

  // Inline variance data for items table
  const getActualForItem = (accountId: string, month: number): number => {
    return storedActuals
      .filter(a => a.account_id === accountId && a.period_month === month)
      .reduce((sum, a) => sum + a.actual_amount, 0);
  };

  const getTotalBudgeted = () => selectedBudget?.total_budgeted || 0;

  const getAccountName = (accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    return account ? `${account.code} - ${account.name}` : "Unknown Account";
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active": return <Badge className="bg-primary/10 text-primary">Active</Badge>;
      case "closed": return <Badge variant="secondary">Closed</Badge>;
      default: return <Badge variant="outline">Draft</Badge>;
    }
  };

  // Variance summary
  const varianceReport = selectedBudget ? getVarianceReport(selectedBudget) : null;

  const stats = {
    total: budgets.length,
    active: budgets.filter(b => b.status === "active").length,
    draft: budgets.filter(b => b.status === "draft").length,
  };

  // Update selected budget when budgets change
  if (selectedBudget) {
    const updated = budgets.find(b => b.id === selectedBudget.id);
    if (updated && updated !== selectedBudget) setSelectedBudget(updated);
  }

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
              <p className="text-sm sm:text-base text-muted-foreground">Plan and track your financial budgets</p>
            </div>
            <RefreshButton
              queryKeyPrefixes={[
                ['finance'] as const,
                ['budgets'] as const,
                queryKeys.reports.budgetVsActual(""),
              ]}
              tooltip="Refresh budgets"
            />
          </div>
          {canManageBudgets && (
            <PermissionGate permission="manageFinancials">
              <Button onClick={() => handleOpenBudgetDialog()} className="w-full sm:w-auto">
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
            <CardContent><div className="text-2xl font-bold">{stats.total}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active</CardTitle>
              <CheckCircle className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent><div className="text-2xl font-bold">{stats.active}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Draft</CardTitle>
              <XCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent><div className="text-2xl font-bold">{stats.draft}</div></CardContent>
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
                <p className="text-muted-foreground">Create your first budget to start planning.</p>
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
                          <Badge variant="outline" className="ml-2 text-[10px] border-destructive text-destructive">FY Closed</Badge>
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(budget.status)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(budget.total_budgeted || 0)}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleViewBudget(budget)}>
                              <Eye className="mr-2 h-4 w-4" /> View & Manage
                            </DropdownMenuItem>
                            {canManageBudgets && (
                              <DropdownMenuItem onClick={() => handleOpenBudgetDialog(budget)}>
                                <Pencil className="mr-2 h-4 w-4" /> Edit
                              </DropdownMenuItem>
                            )}
                            {canManageBudgets && (
                              <DropdownMenuItem onClick={() => { setCopySourceBudget(budget); setCopyTargetYear(budget.fiscal_year + 1); setShowCopyDialog(true); }}>
                                <Copy className="mr-2 h-4 w-4" /> Copy to Next Year
                              </DropdownMenuItem>
                            )}
                            {canManageBudgets && <DropdownMenuSeparator />}
                            {canManageBudgets && budget.status === "draft" && (
                              <DropdownMenuItem onClick={() => handleStatusChange(budget, "active")}>
                                <CheckCircle className="mr-2 h-4 w-4" /> Activate
                              </DropdownMenuItem>
                            )}
                            {canManageBudgets && budget.status === "active" && (
                              <DropdownMenuItem onClick={() => handleStatusChange(budget, "closed")}>
                                <XCircle className="mr-2 h-4 w-4" /> Close Budget
                              </DropdownMenuItem>
                            )}
                            {canManageBudgets && budget.status === "draft" && <DropdownMenuSeparator />}
                            {canManageBudgets && budget.status === "draft" && (
                              <DropdownMenuItem onClick={() => handleDeleteBudget(budget)} className="text-destructive">
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

        {/* Create/Edit Budget Dialog */}
        <Dialog open={showBudgetDialog} onOpenChange={setShowBudgetDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingBudget ? "Edit Budget" : "Create Budget"}</DialogTitle>
              <DialogDescription>
                {editingBudget ? "Update budget details." : "Create a new budget for financial planning."}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmitBudget} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Budget Name *</Label>
                <Input id="name" value={budgetForm.name} onChange={(e) => setBudgetForm({ ...budgetForm, name: e.target.value })} placeholder="e.g., 2024 Operating Budget" required />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="fiscal_year">Fiscal Year *</Label>
                  <Select value={budgetForm.fiscal_year.toString()} onValueChange={(v) => setBudgetForm({ ...budgetForm, fiscal_year: parseInt(v) })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map((year) => (
                        <SelectItem key={year} value={year.toString()}>
                          {year} {isFiscalYearClosed(year) ? "(Closed)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isFiscalYearClosed(budgetForm.fiscal_year) && (
                    <p className="text-xs text-destructive flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> This fiscal year is closed. Budget will be read-only.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Input value={editingBudget ? budgetForm.status : "draft"} disabled className="capitalize" />
                  <p className="text-xs text-muted-foreground">Use actions menu to change status.</p>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea id="description" value={budgetForm.description} onChange={(e) => setBudgetForm({ ...budgetForm, description: e.target.value })} rows={3} />
              </div>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setShowBudgetDialog(false)}>Cancel</Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {editingBudget ? "Update" : "Create"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Copy Budget Dialog */}
        <Dialog open={showCopyDialog} onOpenChange={setShowCopyDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Copy Budget to New Year</DialogTitle>
              <DialogDescription>
                Copy all budget items from "{copySourceBudget?.name}" to a new fiscal year.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Target Fiscal Year</Label>
                <Select value={copyTargetYear.toString()} onValueChange={(v) => setCopyTargetYear(parseInt(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map(y => (
                      <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-sm text-muted-foreground">
                {copySourceBudget?.items?.length || 0} budget item(s) will be copied as a new Draft budget.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCopyDialog(false)}>Cancel</Button>
              <Button onClick={handleCopyBudget} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Copy Budget
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* View Budget Dialog */}
        <Dialog open={showViewDialog} onOpenChange={setShowViewDialog}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {selectedBudget?.name}
                {selectedBudget && getStatusBadge(selectedBudget.status)}
              </DialogTitle>
              <DialogDescription>
                Fiscal Year {selectedBudget?.fiscal_year}
                {selectedBudget?.status === "closed" && " • This budget is closed and read-only."}
              </DialogDescription>
            </DialogHeader>

            {/* Variance Summary Cards */}
            {varianceReport && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
                <Card className="p-3">
                  <p className="text-xs text-muted-foreground">Total Budgeted</p>
                  <p className="text-lg font-bold">{formatCurrency(varianceReport.totalBudgeted)}</p>
                </Card>
                <Card className="p-3">
                  <p className="text-xs text-muted-foreground">Total Actual</p>
                  <p className="text-lg font-bold">{formatCurrency(varianceReport.totalActual)}</p>
                </Card>
                <Card className="p-3">
                  <p className="text-xs text-muted-foreground">Variance</p>
                  <p className={`text-lg font-bold ${varianceReport.totalVariance >= 0 ? "text-primary" : "text-destructive"}`}>
                    {formatCurrency(varianceReport.totalVariance)}
                  </p>
                </Card>
                <Card className="p-3">
                  <p className="text-xs text-muted-foreground">Variance %</p>
                  <p className={`text-lg font-bold ${varianceReport.variancePercent >= 0 ? "text-primary" : "text-destructive"}`}>
                    {varianceReport.variancePercent.toFixed(1)}%
                  </p>
                </Card>
              </div>
            )}

            <Tabs defaultValue="items" className="space-y-4">
              <TabsList>
                <TabsTrigger value="items">Budget Items</TabsTrigger>
                <TabsTrigger value="chart">Chart View</TabsTrigger>
              </TabsList>

              <TabsContent value="items" className="space-y-4">
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <div className="text-lg font-medium">
                    Total Budgeted: {formatCurrency(getTotalBudgeted())}
                  </div>
                  <div className="flex gap-2">
                    {selectedBudget && (
                      <Button variant="outline" size="sm" onClick={() => calculateActuals.mutateAsync(selectedBudget)} disabled={calculateActuals.isPending}>
                        {calculateActuals.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Calculate Actuals
                      </Button>
                    )}
                    {selectedBudget?.status !== "closed" && (
                      <Button onClick={handleOpenItemDialog}>
                        <Plus className="mr-2 h-4 w-4" /> Add Item
                      </Button>
                    )}
                  </div>
                </div>

                {getSelectedBudgetItems().length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No budget items yet. Add items to start planning.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Month</TableHead>
                        <TableHead className="text-right">Budgeted</TableHead>
                        <TableHead className="text-right">Actual</TableHead>
                        <TableHead className="text-right">Variance</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {getSelectedBudgetItems()
                        .sort((a, b) => a.period_month - b.period_month)
                        .map((item) => {
                          const actual = getActualForItem(item.account_id, item.period_month);
                          const variance = item.budgeted_amount - actual;
                          const hasActual = storedActuals.length > 0;
                          return (
                            <TableRow key={item.id}>
                              <TableCell>{getAccountName(item.account_id)}</TableCell>
                              <TableCell>{MONTHS[item.period_month - 1]}</TableCell>
                              <TableCell className="text-right font-medium">{formatCurrency(item.budgeted_amount)}</TableCell>
                              <TableCell className="text-right">{hasActual ? formatCurrency(actual) : <span className="text-muted-foreground text-xs">—</span>}</TableCell>
                              <TableCell className={`text-right font-medium ${hasActual ? (variance >= 0 ? "text-primary" : "text-destructive") : ""}`}>
                                {hasActual ? (
                                  <span className="flex items-center justify-end gap-1">
                                    {variance > 0 && <TrendingDown className="h-3 w-3" />}
                                    {variance < 0 && <TrendingUp className="h-3 w-3" />}
                                    {formatCurrency(variance)}
                                  </span>
                                ) : <span className="text-muted-foreground text-xs">—</span>}
                              </TableCell>
                              <TableCell className="text-muted-foreground truncate max-w-xs">{item.notes || "-"}</TableCell>
                            </TableRow>
                          );
                        })}
                    </TableBody>
                  </Table>
                )}

                {storedActuals.length === 0 && getSelectedBudgetItems().length > 0 && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Click "Calculate Actuals" to pull real GL data and compare against budget.
                    </AlertDescription>
                  </Alert>
                )}
              </TabsContent>

              <TabsContent value="chart">
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={getBudgetTotalByMonth()}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" />
                      <YAxis />
                      <Tooltip
                        formatter={(value: number) => formatCurrency(value)}
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                        }}
                      />
                      <Legend />
                      <Bar dataKey="budgeted" fill="hsl(var(--primary))" name="Budgeted" />
                      <Bar dataKey="actual" fill="hsl(var(--accent-foreground))" name="Actual" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>

        {/* Add Budget Item Dialog */}
        <Dialog open={showItemDialog} onOpenChange={setShowItemDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Budget Item</DialogTitle>
              <DialogDescription>Add a new line item to the budget.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmitItem} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="account">Account *</Label>
                <Select value={itemForm.account_id} onValueChange={(v) => setItemForm({ ...itemForm, account_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                  <SelectContent>
                    {accounts
                      .filter(a => a.account_type === "expense" || a.account_type === "income")
                      .map((account) => (
                        <SelectItem key={account.id} value={account.id}>{account.code} - {account.name}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="month">Month *</Label>
                  <Select value={itemForm.period_month.toString()} onValueChange={(v) => setItemForm({ ...itemForm, period_month: parseInt(v) })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((month, index) => {
                        const monthDate = selectedBudget ? `${selectedBudget.fiscal_year}-${String(index + 1).padStart(2, "0")}-15` : "";
                        const locked = monthDate ? isDateLocked(monthDate) : false;
                        return (
                          <SelectItem key={index + 1} value={(index + 1).toString()} disabled={locked}>
                            {month} {locked ? "(Locked)" : ""}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="amount">Budgeted Amount *</Label>
                  <Input id="amount" type="number" step="0.01" min="0" value={itemForm.budgeted_amount} onChange={(e) => setItemForm({ ...itemForm, budgeted_amount: parseFloat(e.target.value) || 0 })} required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" value={itemForm.notes} onChange={(e) => setItemForm({ ...itemForm, notes: e.target.value })} rows={2} />
              </div>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setShowItemDialog(false)}>Cancel</Button>
                <Button type="submit" disabled={isSubmitting || !itemForm.account_id}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Add Item
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Budget"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />
      </div>
    </>
  );
}
