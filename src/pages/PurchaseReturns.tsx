/**
 * PurchaseReturns — the landing page.
 *
 * Read-only projection plus the canonical action vocabulary: every row menu
 * item comes from `usePurchaseReturnActions`, the same declaration the record
 * page and the peek sheet use, so "Submit / Approve / Dispatch / Raise debit
 * note / Close" can never drift between surfaces. There is no inline create
 * dialog and no status flip here — creation lives on `/purchases/returns/new`
 * (receipt-line picker) and the lifecycle is server-owned.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import {
  Ban,
  CheckCircle,
  Clock,
  Eye,
  FileText,
  MoreHorizontal,
  Package,
  Plus,
  RotateCcw,
  Search,
  TrendingDown,
  Truck,
} from "lucide-react";

import { RefreshButton } from "@/components/ui/RefreshButton";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { usePurchaseReturns, type PurchaseReturn } from "@/hooks/usePurchaseReturns";
import { useCurrency } from "@/hooks/useCurrency";
import { usePeekParam } from "@/design-system";
import { PurchaseReturnPeekSheet } from "@/features/purchases/returns/PurchaseReturnPeekSheet";
import { usePurchaseReturnActions } from "@/features/purchases/returns/usePurchaseReturnActions";
import { reasonCodeLabel } from "@/lib/purchases/purchaseReturnRpcs";
import { Button } from "@/components/ui/button";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { PermissionGate } from "@/components/common/PermissionGate";
import { ScanToDocumentButton } from "@/components/documents/lines/ScanToDocumentButton";

/** The lifecycle, drawn as it actually is: raise → govern → ship → settle. */
const PIPELINE = [
  { key: "draft", label: "Draft" },
  { key: "submitted", label: "Submitted" },
  { key: "approved", label: "Approved" },
  { key: "dispatched", label: "Dispatched" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "credited", label: "Credited" },
  { key: "closed", label: "Closed" },
];

function WorkflowPipeline({ status }: { status: string }) {
  if (status === "cancelled" || status === "rejected") {
    return (
      <div className="flex items-center gap-1">
        <Ban className="h-3.5 w-3.5 text-destructive" />
        <span className="text-xs font-medium text-destructive capitalize">{status}</span>
      </div>
    );
  }
  // Legacy rows: "pending" behaved as a draft, "processed" as settled.
  const normalized =
    status === "pending" ? "draft" : status === "processed" ? "closed" : status;
  const activeStep = PIPELINE.findIndex((s) => s.key === normalized);

  return (
    <div className="flex items-center gap-0.5">
      {PIPELINE.map((step, i) => (
        <div key={step.key} className="flex items-center gap-0.5">
          <div
            className={`h-2 w-2 rounded-full transition-colors ${
              i <= activeStep
                ? i === activeStep
                  ? "bg-primary ring-2 ring-primary/30"
                  : "bg-primary"
                : "bg-muted-foreground/20"
            }`}
            title={step.label}
          />
          {i < PIPELINE.length - 1 && (
            <div
              className={`h-[1.5px] w-3 ${i < activeStep ? "bg-primary" : "bg-muted-foreground/20"}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** One row's menu, driven entirely by the shared action declaration. */
function RowActions({
  pr,
  onPeek,
  onChanged,
}: {
  pr: PurchaseReturn;
  onPeek: () => void;
  onChanged: () => void;
}) {
  const { actions, dialogs } = usePurchaseReturnActions(pr, { onChanged });
  const visible = actions.filter((a) => !a.hidden);
  const core = visible.filter((a) => a.group !== "output");
  const output = visible.filter((a) => a.group === "output");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onPeek}>
            <Eye className="mr-2 h-4 w-4" /> View details
          </DropdownMenuItem>
          {core.length > 0 && <DropdownMenuSeparator />}
          {core.map((a) => (
            <DropdownMenuItem
              key={a.id}
              disabled={a.disabled}
              className={a.destructive ? "text-destructive" : undefined}
              onClick={() => a.onSelect?.()}
            >
              {a.icon && <a.icon className="mr-2 h-4 w-4" />} {a.label}
            </DropdownMenuItem>
          ))}
          {output.length > 0 && <DropdownMenuSeparator />}
          {output.map((a) => (
            <DropdownMenuItem key={a.id} disabled={a.disabled} onClick={() => a.onSelect?.()}>
              {a.icon && <a.icon className="mr-2 h-4 w-4" />} {a.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogs}
    </>
  );
}

export default function PurchaseReturns() {
  const { purchaseReturns, isLoading, refreshPurchaseReturns } = usePurchaseReturns();
  const navigate = useNavigate();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const [peekId, setPeekId] = usePeekParam();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);

  const filteredReturns = useMemo(
    () =>
      purchaseReturns.filter((pr) => {
        const q = searchQuery.toLowerCase();
        const matchesSearch =
          pr.return_number.toLowerCase().includes(q) ||
          (pr.vendor?.name?.toLowerCase().includes(q) ?? false);
        const matchesStatus = statusFilter === "all" || pr.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [purchaseReturns, searchQuery, statusFilter],
  );

  const stats = useMemo(() => {
    const sum = (rows: PurchaseReturn[]) => rows.reduce((s, r) => s + (r.total ?? 0), 0);
    const inStatus = (...s: string[]) =>
      purchaseReturns.filter((pr) => s.includes(pr.status as string));
    return {
      total: purchaseReturns.length,
      totalValue: sum(purchaseReturns),
      awaitingApproval: inStatus("submitted"),
      awaitingDispatch: inStatus("approved"),
      awaitingCredit: inStatus("dispatched", "acknowledged"),
    };
  }, [purchaseReturns]);

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Purchase Returns</h1>
              <p className="text-sm text-muted-foreground sm:text-base">
                Send goods back to suppliers and recover the money with a debit note
              </p>
            </div>
            <RefreshButton onRefresh={refreshPurchaseReturns} tooltip="Refresh purchase returns" />
          </div>
          <div className="flex items-center gap-2">
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "return_number", header: "Return #", width: 14 },
                  { key: "vendor", header: "Supplier", width: 20 },
                  { key: "return_date", header: "Return Date", width: 12 },
                  { key: "reason", header: "Reason", width: 20 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "total", header: "Total", width: 14 },
                ];
                return {
                  title: "Purchase Returns",
                  columns: cols,
                  rows: filteredReturns.map((pr) => ({
                    return_number: pr.return_number,
                    vendor: pr.vendor?.name || "—",
                    return_date: format(new Date(pr.return_date), "MMM d, yyyy"),
                    reason: pr.reason_code ? reasonCodeLabel(pr.reason_code) : pr.reason,
                    status: pr.status,
                    total: pr.total,
                  })),
                  generatedAt: new Date(),
                  currency: baseCurrency,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="managePurchases">
              <ScanToDocumentButton createPath="/purchases/returns/new" label="Scan to return" />
              <Button
                onClick={() => navigate("/purchases/returns/new")}
                className="w-full sm:w-auto"
              >
                <Plus className="mr-2 h-4 w-4" /> Create Return
              </Button>
            </PermissionGate>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <TrendingDown className="h-3.5 w-3.5" />
                Total return value
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold text-destructive sm:text-2xl">
                {formatCurrency(stats.totalValue, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">{stats.total} returns</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Awaiting approval
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold text-amber-600 sm:text-2xl">
                {stats.awaitingApproval.length}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatCurrency(
                  stats.awaitingApproval.reduce((s, r) => s + (r.total ?? 0), 0),
                  baseCurrency,
                )}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Truck className="h-3.5 w-3.5" />
                Awaiting dispatch
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold text-blue-600 sm:text-2xl">
                {stats.awaitingDispatch.length}
              </div>
              <p className="text-xs text-muted-foreground">Approved, stock still on hand</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                Awaiting debit note
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold text-emerald-600 sm:text-2xl">
                {stats.awaitingCredit.length}
              </div>
              <p className="text-xs text-muted-foreground">Shipped, money not yet recovered</p>
            </CardContent>
          </Card>
        </div>

        <div className="filter-bar">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search returns..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {PIPELINE.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardContent className="p-0">
            {isLoading || !currencyReady ? (
              <div className="flex items-center justify-center py-12">
                <RotateCcw className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredReturns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <RotateCcw className="mb-4 h-12 w-12 text-muted-foreground" />
                <h3 className="text-lg font-medium">No purchase returns yet</h3>
                <p className="mb-4 max-w-md text-center text-muted-foreground">
                  A return starts from the goods receipt the stock arrived on, so the cost,
                  lot and warehouse come with it.
                </p>
                <PermissionGate permission="managePurchases">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate("/purchases/returns/new")}
                  >
                    <Plus className="mr-2 h-4 w-4" /> Create Return
                  </Button>
                </PermissionGate>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Return #</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Pipeline</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Debit note</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredReturns.map((pr) => (
                    <TableRow
                      key={pr.id}
                      className="cursor-pointer"
                      onClick={() => setPeekId(pr.id)}
                    >
                      <TableCell className="font-mono font-medium">
                        <div className="flex items-center gap-2">
                          {pr.return_number}
                          {pr.return_kind === "financial" && (
                            <Badge variant="secondary" className="text-[10px]">
                              Financial
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {pr.vendor ? (
                          <ClickableEntity onClick={() => setPreviewContactId(pr.vendor_id)}>
                            {pr.vendor.name}
                          </ClickableEntity>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {format(new Date(pr.return_date), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="max-w-[160px] truncate text-sm">
                        {pr.reason_code ? reasonCodeLabel(pr.reason_code) : pr.reason || "—"}
                      </TableCell>
                      <TableCell>
                        <WorkflowPipeline status={pr.status as string} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          <Package className="mr-1 h-3 w-3" />
                          {pr.items?.length || 0}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {pr.vendor_credit_note_id ? (
                          <Badge variant="outline" className="text-xs">
                            <CheckCircle className="mr-1 h-3 w-3" /> Raised
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium text-destructive">
                        -{formatCurrency(pr.total ?? 0, baseCurrency)}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <RowActions
                          pr={pr}
                          onPeek={() => setPeekId(pr.id)}
                          onChanged={refreshPurchaseReturns}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <PurchaseReturnPeekSheet
        returnId={peekId}
        onOpenChange={(open) => {
          if (!open) setPeekId(null);
        }}
      />

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
