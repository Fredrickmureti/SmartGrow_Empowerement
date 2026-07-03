import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { PermissionGate } from "@/components/common/PermissionGate";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { BranchReadOnlyBanner } from "@/components/finance/BranchReadOnlyBanner";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { Loader2, Lock, Unlock, Plus, Calendar, AlertTriangle, BookOpen, Info } from "lucide-react";
import { format } from "date-fns";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ReturnToMigrationBanner } from "@/components/migration/ReturnToMigrationBanner";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { GeneratePeriodsSheet } from "@/features/finance/fiscal-periods/GeneratePeriodsSheet";
import {
  ClosePeriodSheet,
  type PeriodToClose,
} from "@/features/finance/fiscal-periods/ClosePeriodSheet";

export default function FiscalPeriods() {
  const {
    periods, isLoading, reopenPeriod, getCurrentPeriod,
  } = useFiscalPeriods();
  const { currentOrg } = useOrganization();
  const scope = useFinanceScope();
  const { allowed: canManagePeriods } = useFinancePermission("finance.manage_periods");
  // Fiscal periods are a business-level (parent) action. HQ branch is the
  // canonical edit surface; only NON-HQ branches in a multi-branch business
  // are read-only. The DB trigger added in Wave 4 enforces the same rule
  // server-side via has_finance_permission.
  const insideBranchContext = scope.isBranchScopedReadOnly;
  const canEditPeriods = canManagePeriods && !insideBranchContext;

  const navigate = useNavigate();

  // URL-driven sheet params: ?sheet=generate | ?sheet=close&periodId=<id>
  const [searchParams, setSearchParams] = useSearchParams();
  const sheetKind = searchParams.get("sheet");
  const closingPeriodParam = searchParams.get("periodId");

  const openGenerate = () => {
    const next = new URLSearchParams(searchParams);
    next.set("sheet", "generate");
    setSearchParams(next);
  };
  const closeSheet = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("sheet");
    next.delete("periodId");
    setSearchParams(next);
  };

  const [closingPeriodId, setClosingPeriodId] = useState<string | null>(null);
  const [periodToClose, setPeriodToClose] = useState<PeriodToClose | null>(null);
  void closingPeriodParam;

  const currentPeriod = getCurrentPeriod();

  const handleRequestClose = (period: typeof periods[0]) => {
    setPeriodToClose({
      id: period.id,
      name: period.name,
      start_date: period.start_date,
      end_date: period.end_date,
    });
    const next = new URLSearchParams(searchParams);
    next.set("sheet", "close");
    next.set("periodId", period.id);
    setSearchParams(next);
  };

  const handleReopen = async (periodId: string) => {
    setClosingPeriodId(periodId);
    await reopenPeriod.mutateAsync(periodId);
    setClosingPeriodId(null);
  };

  const getStatusBadge = (status: string, periodId?: string) => {
    const isCurrent = periodId === currentPeriod?.id;
    switch (status) {
      case "open":
        return (
          <div className="flex items-center gap-1.5">
            <Badge className="bg-primary hover:bg-primary/90">Open</Badge>
            {isCurrent && <Badge variant="outline" className="border-primary text-primary text-[10px]">Current</Badge>}
          </div>
        );
      case "closing":
        return <Badge variant="secondary">Closing</Badge>;
      case "closed":
        return <Badge variant="outline" className="border-destructive text-destructive">Closed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const openPeriods = periods.filter(p => p.status === "open");
  const closedPeriods = periods.filter(p => p.status === "closed");

  const isClosing = reopenPeriod.isPending;

  // Group periods by fiscal year
  const periodsByYear = periods.reduce<Record<string, typeof periods>>((acc, p) => {
    const year = new Date(p.start_date).getFullYear().toString();
    if (!acc[year]) acc[year] = [];
    acc[year].push(p);
    return acc;
  }, {});
  const sortedYears = Object.keys(periodsByYear).sort((a, b) => parseInt(b) - parseInt(a));

  return (
    <>
      <ReturnToMigrationBanner />
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-2">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Fiscal Periods</h1>
                <FinanceScopeBadge />
              </div>
              <p className="text-sm text-muted-foreground">
                Manage accounting periods and control when transactions can be modified
              </p>
            </div>
            <RefreshButton
              queryKeyPrefixes={[
                ['fiscal-periods', currentOrg?.id] as const,
              ]}
              tooltip="Refresh fiscal periods"
            />
          </div>
          <div className="flex items-center gap-2">
            <PermissionGate permission="manageFinancials">
              {canEditPeriods && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      navigate(
                        currentPeriod
                          ? `/finance/fiscal-periods/close?year=${new Date(currentPeriod.start_date).getFullYear() - 1}`
                          : "/finance/fiscal-periods/close",
                      )
                    }
                  >
                    <BookOpen className="h-4 w-4 mr-2" /> Year-End Closing
                  </Button>
                  <Button size="sm" onClick={openGenerate}>
                    <Plus className="h-4 w-4 mr-2" /> Generate Periods
                  </Button>
                </>
              )}
            </PermissionGate>
          </div>
        </div>

        <BranchReadOnlyBanner area="Fiscal Periods" permissionLabel="finance.manage_periods" />

        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Open Periods</CardTitle>
              <Unlock className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{openPeriods.length}</div>
              <p className="text-xs text-muted-foreground">Transactions allowed</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Closed Periods</CardTitle>
              <Lock className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{closedPeriods.length}</div>
              <p className="text-xs text-muted-foreground">Transactions locked</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Periods</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{periods.length}</div>
              <p className="text-xs text-muted-foreground">All time</p>
            </CardContent>
          </Card>
        </div>

        {/* Info Alerts */}
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Important:</strong> Closing a fiscal period will prevent any new transactions from being posted to that period. Make sure all entries are complete before closing.
          </AlertDescription>
        </Alert>

        <Alert variant="default" className="border-primary/30 bg-primary/5">
          <Info className="h-4 w-4 text-primary" />
          <AlertDescription className="text-foreground">
            Default GL account mappings are now configured in{" "}
            <Button variant="link" className="h-auto p-0 text-primary" onClick={() => navigate("/finance/settings")}>Finance Settings</Button>.
            This ensures a single source of truth for all automatic GL postings.
          </AlertDescription>
        </Alert>

        {/* Periods grouped by year */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : periods.length === 0 ? (
          <Card>
            <CardContent className="py-8">
              <div className="text-center text-muted-foreground">
                <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No fiscal periods defined</p>
                <p className="text-sm">Generate periods to start tracking accounting periods</p>
              </div>
            </CardContent>
          </Card>
        ) : (
          sortedYears.map(year => {
            const yearPeriods = periodsByYear[year]
              .filter(p => p.period_type === "month" || p.period_type === "quarter")
              .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());
            const yearPeriod = periodsByYear[year].find(p => p.period_type === "year");

            return (
              <Card key={year}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">FY {year}</CardTitle>
                    {yearPeriod && getStatusBadge(yearPeriod.status)}
                  </div>
                  <CardDescription>
                    {yearPeriods.filter(p => p.status === "open").length} open, {yearPeriods.filter(p => p.status === "closed").length} closed
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto -mx-6">
                    <div className="inline-block min-w-full align-middle px-6">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Period</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Start Date</TableHead>
                            <TableHead className="hidden md:table-cell">End Date</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="hidden lg:table-cell">Closed At</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {yearPeriods.map((period) => (
                            <TableRow key={period.id} className="cursor-pointer hover:bg-muted/70" onClick={() => navigate(`/finance/fiscal-periods/${period.id}`)}>
                              <TableCell className="font-medium text-sm text-primary underline-offset-4 hover:underline">{period.name}</TableCell>
                              <TableCell className="text-xs capitalize">{period.period_type}</TableCell>
                              <TableCell className="text-sm">{format(new Date(period.start_date), "MMM d, yyyy")}</TableCell>
                              <TableCell className="text-sm hidden md:table-cell">{format(new Date(period.end_date), "MMM d, yyyy")}</TableCell>
                              <TableCell>{getStatusBadge(period.status, period.id)}</TableCell>
                              <TableCell className="text-sm hidden lg:table-cell">
                                {period.locked_at ? format(new Date(period.locked_at), "MMM d, yyyy HH:mm") : "-"}
                              </TableCell>
                              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                                <PermissionGate permission="manageFinancials" fallback={<span className="text-xs text-muted-foreground">Read-only</span>}>
                                  {!canEditPeriods ? (
                                    <span className="text-xs text-muted-foreground">Read-only</span>
                                  ) : period.status === "open" ? (
                                    <Button variant="outline" size="sm" onClick={() => handleRequestClose(period)} disabled={isClosing || closingPeriodId === period.id}>
                                      {closingPeriodId === period.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Lock className="h-4 w-4 mr-1" />}
                                      <span className="hidden sm:inline">Close</span>
                                    </Button>
                                  ) : period.status === "closed" ? (
                                    <Button variant="ghost" size="sm" onClick={() => handleReopen(period.id)} disabled={isClosing || closingPeriodId === period.id}>
                                      {closingPeriodId === period.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Unlock className="h-4 w-4 mr-1" />}
                                      <span className="hidden sm:inline">Reopen</span>
                                    </Button>
                                  ) : null}
                                </PermissionGate>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Enterprise UX: bulk generate + confirm-close mounted on DetailSheet. */}
      <GeneratePeriodsSheet
        open={sheetKind === "generate"}
        onOpenChange={(o) => (o ? openGenerate() : closeSheet())}
      />
      <ClosePeriodSheet
        open={sheetKind === "close"}
        onOpenChange={(o) => {
          if (!o) {
            setPeriodToClose(null);
            closeSheet();
          }
        }}
        period={periodToClose}
      />
    </>
  );
}
