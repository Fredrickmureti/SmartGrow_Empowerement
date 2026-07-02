import { useState, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { PermissionGate } from "@/components/common/PermissionGate";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { BranchReadOnlyBanner } from "@/components/finance/BranchReadOnlyBanner";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { Loader2, Lock, Unlock, Plus, Calendar, AlertTriangle, BookOpen, Info, CheckCircle2, XCircle, Eye } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { YearEndClosingDialog } from "@/components/finance/YearEndClosingDialog";
import { useNavigate } from "react-router-dom";
import { ReturnToMigrationBanner } from "@/components/migration/ReturnToMigrationBanner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses as useBusinessesHook } from "@/hooks/useBusinesses";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";

/**
 * Fetch close-readiness indicators for a fiscal period:
 * - Unposted journal entries in the period date range
 */
function useCloseReadiness(periodId: string | null, startDate: string, endDate: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinessesHook();

  return useQuery({
    queryKey: ["close-readiness", currentOrg?.id, periodId],
    queryFn: async () => {
      if (!currentOrg?.id || !periodId) return { unpostedCount: 0, draftInvoices: 0 };

      const businessId = currentBusiness?.id;
      if (!businessId) return { unpostedCount: 0, draftInvoices: 0 };
      const [unpostedResult, draftInvoicesResult] = await Promise.all([
        supabase
          .from("journal_entries")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id)
          .eq("business_id", businessId)
          .eq("status", "draft")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate),
        supabase
          .from("invoices")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id)
          .eq("business_id", businessId)
          .eq("status", "draft")
          .gte("issue_date", startDate)
          .lte("issue_date", endDate),
      ]);

      return {
        unpostedCount: unpostedResult.count || 0,
        draftInvoices: draftInvoicesResult.count || 0,
      };
    },
    enabled: !!currentOrg?.id && !!periodId,
    staleTime: 30_000,
  });
}

export default function FiscalPeriods() {
  const {
    periods, isLoading, generatePeriods, closePeriod, reopenPeriod, getCurrentPeriod,
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
  const [generateYear, setGenerateYear] = useState(new Date().getFullYear().toString());
  const [generateType, setGenerateType] = useState<"month" | "quarter">("month");
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [showYearEndDialog, setShowYearEndDialog] = useState(false);
  const [showConfirmCloseDialog, setShowConfirmCloseDialog] = useState(false);
  const [closingPeriodId, setClosingPeriodId] = useState<string | null>(null);
  const [periodToClose, setPeriodToClose] = useState<{ id: string; name: string; start_date: string; end_date: string } | null>(null);

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);
  const currentPeriod = getCurrentPeriod();

  // Fetch fiscal year start month for preview
  const { data: orgFiscalConfig } = useQuery({
    queryKey: ["org-fiscal-config", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return { fiscal_year_start: 1 };
      // Identity moved to `businesses` table (Odoo: res.company).
      const { data } = await supabase
        .from("businesses")
        .select("fiscal_year_start")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      return { fiscal_year_start: data?.fiscal_year_start || 1 };
    },
    enabled: !!currentOrg?.id,
  });

  const fiscalStartMonth = orgFiscalConfig?.fiscal_year_start || 1;
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // Generate preview of periods that would be created
  const previewPeriods = useMemo(() => {
    const year = parseInt(generateYear);
    const startMonth = fiscalStartMonth - 1; // 0-indexed
    const fyStartDate = new Date(year, startMonth, 1);

    const items: Array<{ name: string; start: string; end: string }> = [];

    if (generateType === "month") {
      for (let i = 0; i < 12; i++) {
        const monthDate = new Date(fyStartDate.getFullYear(), fyStartDate.getMonth() + i, 1);
        items.push({
          name: format(monthDate, "MMMM yyyy"),
          start: format(startOfMonth(monthDate), "MMM d, yyyy"),
          end: format(endOfMonth(monthDate), "MMM d, yyyy"),
        });
      }
    } else {
      for (let q = 0; q < 4; q++) {
        const qStart = new Date(fyStartDate.getFullYear(), fyStartDate.getMonth() + q * 3, 1);
        const qEnd = new Date(fyStartDate.getFullYear(), fyStartDate.getMonth() + q * 3 + 3, 0);
        items.push({
          name: `Q${q + 1} FY${year}`,
          start: format(qStart, "MMM d, yyyy"),
          end: format(qEnd, "MMM d, yyyy"),
        });
      }
    }

    // Yearly period
    const fyEnd = new Date(year + (fiscalStartMonth === 1 ? 0 : 1), fiscalStartMonth === 1 ? 11 : fiscalStartMonth - 2 + 1, 0);
    items.push({
      name: `FY ${year}`,
      start: format(fyStartDate, "MMM d, yyyy"),
      end: format(fyEnd, "MMM d, yyyy"),
    });

    return items;
  }, [generateYear, generateType, fiscalStartMonth]);

  // Count existing periods for the selected year
  const existingPeriodsForYear = useMemo(() => {
    const year = parseInt(generateYear);
    return periods.filter(p => p.name.includes(year.toString())).length;
  }, [generateYear, periods]);

  // Close readiness for the period being inspected
  const { data: readiness } = useCloseReadiness(
    periodToClose?.id || null,
    periodToClose?.start_date || "",
    periodToClose?.end_date || ""
  );

  // Group periods by fiscal year
  const periodsByYear = periods.reduce<Record<string, typeof periods>>((acc, p) => {
    const year = new Date(p.start_date).getFullYear().toString();
    if (!acc[year]) acc[year] = [];
    acc[year].push(p);
    return acc;
  }, {});

  const sortedYears = Object.keys(periodsByYear).sort((a, b) => parseInt(b) - parseInt(a));

  const handleGenerate = async () => {
    await generatePeriods.mutateAsync({ year: parseInt(generateYear), periodType: generateType });
    setShowGenerateDialog(false);
  };

  const handleRequestClose = (period: typeof periods[0]) => {
    setPeriodToClose({ id: period.id, name: period.name, start_date: period.start_date, end_date: period.end_date });
    setShowConfirmCloseDialog(true);
  };

  const handleConfirmClose = async () => {
    if (!periodToClose) return;
    setClosingPeriodId(periodToClose.id);
    await closePeriod.mutateAsync({ periodId: periodToClose.id });
    setClosingPeriodId(null);
    setShowConfirmCloseDialog(false);
    setPeriodToClose(null);
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

  const isGenerating = generatePeriods.isPending;
  const isClosing = closePeriod.isPending || reopenPeriod.isPending;

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
                  <Button variant="outline" size="sm" onClick={() => setShowYearEndDialog(true)}>
                    <BookOpen className="h-4 w-4 mr-2" /> Year-End Closing
                  </Button>
                  <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
                    <DialogTrigger asChild>
                      <Button size="sm"><Plus className="h-4 w-4 mr-2" /> Generate Periods</Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-lg">
                      <DialogHeader>
                        <DialogTitle>Generate Fiscal Periods</DialogTitle>
                        <DialogDescription>
                          Create fiscal periods for a year. Existing periods will not be duplicated.
                          {fiscalStartMonth !== 1 && (
                            <span className="block mt-1 font-medium text-foreground">
                              Fiscal year starts in {monthNames[fiscalStartMonth - 1]}.
                            </span>
                          )}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Year</label>
                          <Select value={generateYear} onValueChange={setGenerateYear}>
                            <SelectTrigger><SelectValue placeholder="Select year" /></SelectTrigger>
                            <SelectContent>
                              {yearOptions.map(year => (
                                <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Period Type</label>
                          <Select value={generateType} onValueChange={(v) => setGenerateType(v as "month" | "quarter")}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="month">Monthly (12 periods)</SelectItem>
                              <SelectItem value="quarter">Quarterly (4 periods)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {existingPeriodsForYear > 0 && (
                          <Alert>
                            <Info className="h-4 w-4" />
                            <AlertTitle>Existing periods</AlertTitle>
                            <AlertDescription className="text-xs">
                              {existingPeriodsForYear} period(s) already exist for {generateYear}. Duplicates will be skipped.
                            </AlertDescription>
                          </Alert>
                        )}

                        {/* Period Preview */}
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Eye className="h-4 w-4 text-muted-foreground" />
                            <label className="text-sm font-medium">Preview ({previewPeriods.length} periods)</label>
                          </div>
                          <ScrollArea className="h-48 rounded-md border">
                            <div className="p-2 space-y-1">
                              {previewPeriods.map((p, i) => (
                                <div key={i} className="flex items-center justify-between text-xs py-1 px-2 rounded hover:bg-muted/50">
                                  <span className="font-medium">{p.name}</span>
                                  <span className="text-muted-foreground">{p.start} — {p.end}</span>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>Cancel</Button>
                        <Button onClick={handleGenerate} disabled={isGenerating}>
                          {isGenerating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Generate
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </>
              )}
            </PermissionGate>
          </div>
        </div>

        <BranchReadOnlyBanner area="Fiscal Periods" permissionLabel="finance.manage_periods" />

        {/* Year-End Closing Dialog */}
        <YearEndClosingDialog open={showYearEndDialog} onOpenChange={setShowYearEndDialog} />

        {/* Period Close Confirmation Dialog */}
        <Dialog open={showConfirmCloseDialog} onOpenChange={setShowConfirmCloseDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Close Period: {periodToClose?.name}</DialogTitle>
              <DialogDescription>
                Closing this period will prevent any new transactions from being posted within its date range.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <p className="text-sm font-medium">Close Readiness Check</p>
              {readiness ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-2 rounded bg-muted/50">
                    <span className="text-sm">Unposted Journal Entries</span>
                    <span className={`text-sm font-medium flex items-center gap-1 ${readiness.unpostedCount > 0 ? "text-destructive" : "text-primary"}`}>
                      {readiness.unpostedCount > 0 ? <XCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      {readiness.unpostedCount}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded bg-muted/50">
                    <span className="text-sm">Draft Invoices</span>
                    <span className={`text-sm font-medium flex items-center gap-1 ${readiness.draftInvoices > 0 ? "text-destructive" : "text-primary"}`}>
                      {readiness.draftInvoices > 0 ? <XCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      {readiness.draftInvoices}
                    </span>
                  </div>
                  {(readiness.unpostedCount > 0 || readiness.draftInvoices > 0) && (
                    <Alert variant="destructive" className="mt-2">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Items require attention</AlertTitle>
                      <AlertDescription className="text-xs">
                        There are unfinalized items in this period. You can still close it, but those items will be locked in their current state.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking readiness...
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowConfirmCloseDialog(false); setPeriodToClose(null); }}>Cancel</Button>
              <Button variant="destructive" onClick={handleConfirmClose} disabled={isClosing}>
                {isClosing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <Lock className="h-4 w-4 mr-2" /> Close Period
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
                              <TableCell className="text-right">
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
    </>
  );
}
