// @ts-nocheck
import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useCurrency } from "@/hooks/useCurrency";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { Input } from "@/components/ui/input";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Download, FileText, Calendar, ChevronDown, ChevronRight } from "lucide-react";
import { format } from "date-fns";

interface AgingBill {
  id: string;
  bill_number: string;
  due_date: string;
  balance: number;
  bucket: string;
}

interface AgingRow {
  vendor_id: string;
  vendor_name: string;
  not_due: number;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  total: number;
  bills: AgingBill[];
}


export default function AgedPayables() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { formatCurrency, baseCurrency } = useCurrency();
  const [isLoading, setIsLoading] = useState(true);
  const [agingData, setAgingData] = useState<AgingRow[]>([]);
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split("T")[0]);
  const [searchQuery, setSearchQuery] = useState("");
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  const [expandedVendors, setExpandedVendors] = useState<Set<string>>(new Set());
  // Phase 10: branch toggle. Default to current branch when one is active,
  // otherwise show all branches (Odoo behavior). User can flip between them.
  const [branchScope, setBranchScope] = useState<"current" | "all">(
    currentBranch?.id ? "current" : "all"
  );
  const navigate = useNavigate();

  const fetchAgingData = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;
    setIsLoading(true);

    try {
      // Phase 10: server-side aggregation via get_ap_aging_summary RPC.
      // Was previously a client-side reduce over a 1000-row Supabase query
      // — broke for any company past 1000 lifetime bills.
      const branchFilter =
        branchScope === "current" && currentBranch?.id ? currentBranch.id : null;

      const { data, error } = await supabase.rpc("get_ap_aging_summary" as any, {
        p_organization_id: currentOrg.id,
        p_business_id: currentBusiness.id,
        p_branch_id: branchFilter,
        p_as_of: asOfDate,
      });
      if (error) throw error;

      const result = data as any;
      const vendors: AgingRow[] = (result?.vendors || []).map((v: any) => ({
        vendor_id: v.vendor_id || "unknown",
        vendor_name: v.vendor_name || "Unknown Vendor",
        not_due: Number(v.not_due || 0),
        current: Number(v.current || 0),
        days30: Number(v.days30 || 0),
        days60: Number(v.days60 || 0),
        days90: Number(v.days90 || 0),
        total: Number(v.total || 0),

        bills: (v.bills || []).map((b: any) => ({
          id: b.id,
          bill_number: b.bill_number || b.id?.slice(0, 8),
          due_date: b.due_date,
          balance: Number(b.balance || 0),
          bucket: b.bucket || "current",
        })),
      }));

      setAgingData(vendors.sort((a, b) => b.total - a.total));
    } catch (err) {
      console.error("Error fetching aged payables:", err);
      setAgingData([]);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id, branchScope, asOfDate]);

  useEffect(() => {
    fetchAgingData();
  }, [fetchAgingData]);

  const filteredData = useMemo(() => {
    if (!searchQuery) return agingData;
    return agingData.filter((row) =>
      row.vendor_name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [agingData, searchQuery]);

  const totals = useMemo(() => {
    return filteredData.reduce(
      (acc, row) => ({
        not_due: acc.not_due + row.not_due,
        current: acc.current + row.current,
        days30: acc.days30 + row.days30,
        days60: acc.days60 + row.days60,
        days90: acc.days90 + row.days90,
        total: acc.total + row.total,
      }),
      { not_due: 0, current: 0, days30: 0, days60: 0, days90: 0, total: 0 }
    );
  }, [filteredData]);

  const getExportConfig = useCallback((): ExportConfig => {
    const cols: ExportColumn[] = [
      { key: "vendor", header: "Vendor", width: 22 },
      { key: "not_due", header: AGING_BUCKET_LABELS.not_due, format: "currency", width: 14, align: "right" },
      { key: "current", header: AGING_BUCKET_LABELS.current, format: "currency", width: 14, align: "right" },
      { key: "days30", header: AGING_BUCKET_LABELS.days30, format: "currency", width: 14, align: "right" },
      { key: "days60", header: AGING_BUCKET_LABELS.days60, format: "currency", width: 14, align: "right" },
      { key: "days90", header: AGING_BUCKET_LABELS.days90, format: "currency", width: 14, align: "right" },
      { key: "total", header: "Total", format: "currency", width: 14, align: "right" },
    ];
    const rows = [
      ...filteredData.map((row) => ({
        vendor: row.vendor_name,
        not_due: row.not_due,
        current: row.current,
        days30: row.days30,
        days60: row.days60,
        days90: row.days90,
        total: row.total,
        _isGrandTotal: false,
      })),
      {
        vendor: "TOTAL",
        not_due: totals.not_due,
        current: totals.current,
        days30: totals.days30,
        days60: totals.days60,
        days90: totals.days90,
        total: totals.total,
        _isGrandTotal: true,
      },
    ];
    return {
      title: "Aged Payables",
      subtitle: `As of ${asOfDate}`,
      columns: cols,
      rows,
      generatedAt: new Date(),
      currency: baseCurrency,
      organizationId: currentOrg?.id,
      businessId: currentBusiness?.id,
    };
  }, [filteredData, totals, asOfDate, baseCurrency, currentOrg?.id, currentBusiness?.id]);




  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Aged Payables</h1>
              <p className="text-sm text-muted-foreground">
                Outstanding vendor bills grouped by aging period
              </p>
            </div>
            <RefreshButton onRefresh={fetchAgingData} tooltip="Refresh aging report" />
          </div>
          <ReportExportButtons
            compact
            formats={["excel", "csv", "print", "pdf"]}
            reportSubtype="aged_payables"
            getExportConfig={getExportConfig}
          />
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground">Current</p>
              <p className="text-lg font-bold text-foreground">{formatCurrency(totals.current)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground">1-30 Days</p>
              <p className="text-lg font-bold text-accent-foreground">{formatCurrency(totals.days_1_30)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground">31-60 Days</p>
              <p className="text-lg font-bold text-accent-foreground">{formatCurrency(totals.days_31_60)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground">61-90 Days</p>
              <p className="text-lg font-bold text-destructive">{formatCurrency(totals.days_61_90)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground">90+ Days</p>
              <p className="text-lg font-bold text-destructive">{formatCurrency(totals.over_90)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground">Total Outstanding</p>
              <p className="text-lg font-bold">{formatCurrency(totals.total)}</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search vendors..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          {currentBranch?.id && (
            <Select value={branchScope} onValueChange={(v: any) => setBranchScope(v)}>
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

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredData.length === 0 ? (
          <div className="text-center py-12">
            <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium">No outstanding payables</h3>
            <p className="text-muted-foreground">All vendor bills are fully paid as of {format(new Date(asOfDate), "MMM d, yyyy")}</p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Current</TableHead>
                  <TableHead className="text-right">1-30 Days</TableHead>
                  <TableHead className="text-right">31-60 Days</TableHead>
                  <TableHead className="text-right">61-90 Days</TableHead>
                  <TableHead className="text-right">90+ Days</TableHead>
                  <TableHead className="text-right font-bold">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredData.map((row) => {
                  const isExpanded = expandedVendors.has(row.vendor_id);
                  return (
                    <>
                    <TableRow
                      key={row.vendor_id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => {
                        setExpandedVendors(prev => {
                          const next = new Set(prev);
                          if (next.has(row.vendor_id)) next.delete(row.vendor_id);
                          else next.add(row.vendor_id);
                          return next;
                        });
                      }}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                          <ClickableEntity onClick={(e) => { e.stopPropagation(); setPreviewContactId(row.vendor_id); }}>
                            {row.vendor_name}
                          </ClickableEntity>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.current > 0 ? formatCurrency(row.current) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.days_1_30 > 0 ? formatCurrency(row.days_1_30) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.days_31_60 > 0 ? formatCurrency(row.days_31_60) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.days_61_90 > 0 ? formatCurrency(row.days_61_90) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.over_90 > 0 ? (
                          <span className="text-destructive font-medium">{formatCurrency(row.over_90)}</span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-bold tabular-nums">
                        {formatCurrency(row.total)}
                      </TableCell>
                    </TableRow>
                    {isExpanded && row.bills.sort((a, b) => b.balance - a.balance).map((bill) => (
                      <TableRow
                        key={bill.id}
                        className="bg-muted/20 cursor-pointer hover:bg-muted/40"
                        onClick={() => navigate(`/purchases/bills?id=${bill.id}`)}
                      >
                        <TableCell className="pl-10 text-xs text-primary">
                          {bill.bill_number}
                          <span className="ml-2 text-muted-foreground">
                            Due {format(new Date(bill.due_date), "MMM d, yyyy")}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{bill.bucket === "current" ? formatCurrency(bill.balance) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{bill.bucket === "1-30" ? formatCurrency(bill.balance) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{bill.bucket === "31-60" ? formatCurrency(bill.balance) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{bill.bucket === "61-90" ? formatCurrency(bill.balance) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{bill.bucket === "90+" ? <span className="text-destructive">{formatCurrency(bill.balance)}</span> : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs font-medium">{formatCurrency(bill.balance)}</TableCell>
                      </TableRow>
                    ))}
                    </>
                  );
                })}
                {/* Totals row */}
                <TableRow className="bg-muted/50 font-bold">
                  <TableCell>Total ({filteredData.length} vendors)</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals.current)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals.days_1_30)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals.days_31_60)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals.days_61_90)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals.over_90)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(totals.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <ContactPreviewDrawer
        open={!!previewContactId}
        onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
        contactId={previewContactId}
      />
    </>
  );
}
