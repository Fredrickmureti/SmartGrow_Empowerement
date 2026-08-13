/**
 * Aged Payables.
 *
 * Every number on this screen comes from `get_ap_aging_summary`, which is
 * built on the point-in-time AP subledger projection
 * `finance_ap_open_items_as_of`. The browser does no aging arithmetic, no
 * residual derivation and never reads bill status or paid-to-date columns:
 * the residual decides whether a document is open, and the as-of date bounds
 * both the obligation and every settlement against it.
 *
 * Phase 5.5 — search and paging are SERVER-side. The browser never filters or
 * slices the vendor list, so a 10k-vendor tenant transfers one page, and the
 * export re-runs the same query with no page limit rather than exporting
 * whatever happened to be loaded.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useCurrency } from "@/hooks/useCurrency";
import { useApAging, fetchApAging, type ApAgingVendor } from "@/hooks/useApAging";

import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  Search,
  FileText,
  Calendar,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import { format } from "date-fns";
import { AGING_BUCKET_LABELS, AGING_BUCKET_SHORT_LABELS } from "@/services/finance/aging";

const PAGE_SIZE = 50;

const fmtDate = (value: string | null) =>
  value ? format(new Date(value), "MMM d, yyyy") : "—";

export default function AgedPayables() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { formatCurrency, baseCurrency } = useCurrency();
  const navigate = useNavigate();

  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split("T")[0]);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  const [expandedVendors, setExpandedVendors] = useState<Set<string>>(new Set());
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
  const [branchScope, setBranchScope] = useState<"current" | "all">(
    currentBranch?.id ? "current" : "all",
  );

  // Debounce keystrokes into the server query; the browser never filters rows.
  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedSearch(searchQuery.trim());
      setPageLimit(PAGE_SIZE);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const branchFilter =
    branchScope === "current" && currentBranch?.id ? currentBranch.id : null;

  const agingArgs = {
    organizationId: currentOrg?.id,
    businessId: currentBusiness?.id,
    branchId: branchFilter,
    asOf: asOfDate,
    search: appliedSearch || null,
  };

  const { data, isLoading, isFetching, refetch } = useApAging({
    ...agingArgs,
    limit: pageLimit,
    offset: 0,
  });

  const vendors: ApAgingVendor[] = data?.vendors ?? [];
  const totals = data?.totals;
  const reconciliation = data?.reconciliation;
  const page = data?.page;
  const matchedCount = page?.filteredVendorCount ?? vendors.length;
  const remaining = Math.max(matchedCount - vendors.length, 0);



  const toggleVendor = (vendorId: string) =>
    setExpandedVendors((prev) => {
      const next = new Set(prev);
      if (next.has(vendorId)) next.delete(vendorId);
      else next.add(vendorId);
      return next;
    });

  const getExportConfig = async (): Promise<ExportConfig> => {
    const cols: ExportColumn[] = [
      { key: "vendor", header: "Vendor", width: 22 },
      { key: "not_due", header: AGING_BUCKET_LABELS.not_due, format: "currency", width: 14, align: "right" },
      { key: "current", header: AGING_BUCKET_LABELS.current, format: "currency", width: 14, align: "right" },
      { key: "days30", header: AGING_BUCKET_LABELS.days30, format: "currency", width: 14, align: "right" },
      { key: "days60", header: AGING_BUCKET_LABELS.days60, format: "currency", width: 14, align: "right" },
      { key: "days90", header: AGING_BUCKET_LABELS.days90, format: "currency", width: 14, align: "right" },
      { key: "credit", header: "Unapplied credit", format: "currency", width: 14, align: "right" },
      { key: "total", header: "Total", format: "currency", width: 14, align: "right" },
    ];
    // Exports re-run the SAME engine query with no page limit, so the file is
    // the complete searched cohort rather than the page on screen. No browser
    // aggregation, no second data source.
    const full = await fetchApAging({ ...agingArgs, limit: null, offset: 0 });
    const rows = [
      ...full.vendors.map((row) => ({
        vendor: row.vendorName,
        not_due: row.not_due,
        current: row.current,
        days30: row.days30,
        days60: row.days60,
        days90: row.days90,
        credit: row.credit,
        total: row.total,
        _isGrandTotal: false,
      })),
      {
        vendor: "TOTAL",
        not_due: full.totals.not_due,
        current: full.totals.current,
        days30: full.totals.days30,
        days60: full.totals.days60,
        days90: full.totals.days90,
        credit: full.totals.credit,
        total: full.totals.total,
        _isGrandTotal: true,
      },
    ];
    return {
      title: "Aged Payables",
      subtitle: `As of ${asOfDate}`,
      columns: cols,
      rows,
      generatedAt: new Date(),
      currency: full.currency ?? baseCurrency,
      organizationId: currentOrg?.id,
      businessId: currentBusiness?.id,
    };

  };

  const summaryCards = [
    { label: AGING_BUCKET_LABELS.not_due, value: totals?.not_due ?? 0, tone: "text-foreground" },
    { label: `${AGING_BUCKET_LABELS.current} overdue`, value: totals?.current ?? 0, tone: "text-accent-foreground" },
    { label: AGING_BUCKET_LABELS.days30, value: totals?.days30 ?? 0, tone: "text-accent-foreground" },
    { label: AGING_BUCKET_LABELS.days60, value: totals?.days60 ?? 0, tone: "text-destructive" },
    { label: AGING_BUCKET_LABELS.days90, value: totals?.days90 ?? 0, tone: "text-destructive" },
    { label: "Unapplied credit", value: totals?.credit ?? 0, tone: "text-muted-foreground" },
    { label: "Total outstanding", value: totals?.total ?? 0, tone: "text-foreground" },
  ];

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Aged Payables</h1>
              <p className="text-sm text-muted-foreground">
                What we owed as of {fmtDate(asOfDate)}, from the AP subledger
              </p>
            </div>
            <RefreshButton onRefresh={async () => { await refetch(); }} tooltip="Refresh aging report" />
          </div>
          <ReportExportButtons
            compact
            formats={["excel", "csv", "print", "pdf"]}
            reportSubtype="aged_payables"
            getExportConfig={getExportConfig}
          />
        </div>

        {reconciliation && !reconciliation.inBalance && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Aging total {formatCurrency(reconciliation.agingTotal)} does not match the AP
              control account {formatCurrency(reconciliation.controlAccountBalance)} as of{" "}
              {fmtDate(asOfDate)} — variance {formatCurrency(reconciliation.variance)}.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {summaryCards.map((card) => (
            <Card key={card.label}>
              <CardContent className="pt-4 pb-3 px-4">
                <p className="text-xs text-muted-foreground">{card.label}</p>
                <p className={`text-lg font-bold ${card.tone}`}>{formatCurrency(card.value)}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search vendors..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              className="pl-9"
            />
          </div>
          {currentBranch?.id && (
            <Select
              value={branchScope}
              onValueChange={(v: "current" | "all") => setBranchScope(v)}
            >
              <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current branch</SelectItem>
                <SelectItem value="all">All branches</SelectItem>
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <Input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="w-[180px]"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredVendors.length === 0 ? (
          <div className="text-center py-12">
            <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium">No outstanding payables</h3>
            <p className="text-muted-foreground">
              Nothing was open as of {fmtDate(asOfDate)}
            </p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.not_due}</TableHead>
                  <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.current}</TableHead>
                  <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.days30}</TableHead>
                  <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.days60}</TableHead>
                  <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.days90}</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right font-bold">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleVendors.map((row: ApAgingVendor) => {
                  const isExpanded = expandedVendors.has(row.vendorId);
                  return (
                    <>
                      <TableRow
                        key={row.vendorId}
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => toggleVendor(row.vendorId)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span onClick={(e) => e.stopPropagation()}>
                              <ClickableEntity
                                onClick={() => {
                                  setPreviewContactId(row.vendorId);
                                }}
                              >
                                {row.vendorName}
                              </ClickableEntity>
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.not_due > 0 ? formatCurrency(row.not_due) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.current > 0 ? formatCurrency(row.current) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.days30 > 0 ? formatCurrency(row.days30) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.days60 > 0 ? formatCurrency(row.days60) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.days90 > 0 ? (
                            <span className="text-destructive font-medium">
                              {formatCurrency(row.days90)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {row.credit > 0 ? `(${formatCurrency(row.credit)})` : "—"}
                        </TableCell>
                        <TableCell className="text-right font-bold tabular-nums">
                          {formatCurrency(row.total)}
                        </TableCell>
                      </TableRow>

                      {isExpanded && (
                        <TableRow key={`${row.vendorId}-detail`} className="bg-muted/20">
                          <TableCell colSpan={8} className="p-0">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="text-xs">Document</TableHead>
                                  <TableHead className="text-xs">Date</TableHead>
                                  <TableHead className="text-xs">Due</TableHead>
                                  <TableHead className="text-xs text-right">Original</TableHead>
                                  <TableHead className="text-xs text-right">Paid</TableHead>
                                  <TableHead className="text-xs text-right">Credited</TableHead>
                                  <TableHead className="text-xs text-right">Residual</TableHead>
                                  <TableHead className="text-xs text-right">Days</TableHead>
                                  <TableHead className="text-xs">Bucket</TableHead>
                                  <TableHead className="text-xs text-right">Links</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {row.bills.map((bill) => (
                                  <TableRow key={bill.id} className="text-xs">
                                    <TableCell>
                                      <ClickableEntity
                                        onClick={() =>
                                          bill.sourceKind === "bill"
                                            ? navigate(`/purchases/bills?id=${bill.id}`)
                                            : navigate(`/accounting/journal-entries?id=${bill.id}`)
                                        }
                                      >
                                        {bill.billNumber}
                                      </ClickableEntity>
                                    </TableCell>
                                    <TableCell>{fmtDate(bill.documentDate)}</TableCell>
                                    <TableCell>{fmtDate(bill.dueDate)}</TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {formatCurrency(bill.documentTotal)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {bill.paid > 0 ? formatCurrency(bill.paid) : "—"}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {bill.credited > 0 ? formatCurrency(bill.credited) : "—"}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums font-medium">
                                      {formatCurrency(bill.balance)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {bill.daysPastDue > 0 ? bill.daysPastDue : "—"}
                                    </TableCell>
                                    <TableCell>
                                      {AGING_BUCKET_SHORT_LABELS[bill.bucket] ?? bill.bucket}
                                    </TableCell>
                                    <TableCell className="text-right space-x-2">
                                      <ClickableEntity
                                        onClick={() =>
                                          navigate(`/purchases/statements?vendor=${row.vendorId}`)
                                        }
                                      >
                                        Statement
                                      </ClickableEntity>
                                      {bill.journalEntryId && (
                                        <ClickableEntity
                                          onClick={() =>
                                            navigate(
                                              `/accounting/journal-entries?id=${bill.journalEntryId}`,
                                            )
                                          }
                                        >
                                          Journal
                                        </ClickableEntity>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}

                <TableRow className="bg-muted/50 font-bold">
                  <TableCell>Total ({totals?.vendorCount ?? 0} vendors)</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals?.not_due ?? 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals?.current ?? 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals?.days30 ?? 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals?.days60 ?? 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals?.days90 ?? 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals?.credit ?? 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals?.total ?? 0)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>

            {remaining > 0 && (
              <div className="flex flex-col items-center gap-1 p-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isFetching}
                  onClick={() => setPageLimit((c) => c + PAGE_SIZE)}
                >
                  {isFetching && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                  Show more ({remaining} remaining)
                </Button>
                <p className="text-xs text-muted-foreground">
                  Showing {vendors.length} of {matchedCount} vendors
                </p>
              </div>
            )}

          </div>
        )}
      </div>

      <ContactPreviewDrawer
        open={!!previewContactId}
        onOpenChange={(open) => {
          if (!open) setPreviewContactId(null);
        }}
        contactId={previewContactId}
      />
    </>
  );
}
