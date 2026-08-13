/**
 * AP Reconciliation — the operator surface behind the Aged Payables variance
 * badge.
 *
 * The header numbers come from `finance_ap_aging_reconciliation`; the rows come
 * from `finance_ap_reconciliation_detail`. Both are computed in SQL from the
 * same point-in-time engine and the same subledger rows, so the rows explain
 * the header exactly. Nothing on this screen is recomputed in the browser.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useCurrency } from "@/hooks/useCurrency";
import { useApAging } from "@/hooks/useApAging";
import {
  useApReconciliationDetail,
  AP_VARIANCE_REASON_LABELS,
  AP_VARIANCE_REASON_HINTS,
} from "@/hooks/useApReconciliation";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  HelpCircle,
  Loader2,
  AlertTriangle,
} from "lucide-react";

const fmtDate = (value: string) => (value ? format(new Date(value), "MMM d, yyyy") : "—");

export default function ApReconciliation() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();

  // The as-of date carries over from Aged Payables so both screens answer the
  // same question on the same date.
  const asOfParam =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("as_of")
      : null;
  const [asOfDate, setAsOfDate] = useState(
    asOfParam || new Date().toISOString().split("T")[0],
  );
  const [branchScope, setBranchScope] = useState<"current" | "all">(
    currentBranch?.id ? "current" : "all",
  );


  const branchFilter = branchScope === "current" && currentBranch?.id ? currentBranch.id : null;

  const scope = {
    organizationId: currentOrg?.id,
    businessId: currentBusiness?.id,
    branchId: branchFilter,
    asOf: asOfDate,
  };

  // Header figures: the same reconciliation the Aged Payables badge shows.
  const { data: aging, isFetching: agingFetching } = useApAging({ ...scope, limit: 1, offset: 0 });
  const reconciliation = aging?.reconciliation ?? null;

  const { data: rows = [], isLoading, isFetching, refetch } = useApReconciliationDetail(scope);

  const headerCards = [
    { label: "Aging total (net of credits)", value: reconciliation?.agingTotal ?? 0 },
    { label: "AP control account", value: reconciliation?.controlAccountBalance ?? 0 },
    { label: "Variance", value: reconciliation?.variance ?? 0, emphasise: true },
  ];

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate("/purchases/aged-payables")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="page-title">AP Reconciliation</h1>
            <p className="text-sm text-muted-foreground">
              Why the AP subledger and the control account disagree as of {fmtDate(asOfDate)}
            </p>
          </div>
          <RefreshButton
            onRefresh={async () => {
              await refetch();
            }}
            tooltip="Re-run reconciliation"
          />
        </div>
        <div className="flex items-center gap-3">
          {currentBranch?.id && (
            <Select value={branchScope} onValueChange={(v: "current" | "all") => setBranchScope(v)}>
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
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
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {headerCards.map((card) => (
          <Card key={card.label}>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p
                className={`text-lg font-bold tabular-nums ${
                  card.emphasise && !reconciliation?.inBalance
                    ? "text-destructive"
                    : "text-foreground"
                }`}
              >
                {formatCurrency(card.value)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {reconciliation?.inBalance && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            The AP subledger reconciles to the control account as of {fmtDate(asOfDate)}. Any rows
            below are offsetting differences that net to zero overall.
          </AlertDescription>
        </Alert>
      )}

      {reconciliation && !reconciliation.inBalance && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Variance {formatCurrency(reconciliation.variance)} as of {fmtDate(asOfDate)}. The rows
            below account for it, largest first.
          </AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium">No vendor-level differences</h3>
          <p className="text-muted-foreground">
            Every vendor's aging position equals its AP control-account balance as of{" "}
            {fmtDate(asOfDate)}.
          </p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead>Cause</TableHead>
                <TableHead className="text-right">Open documents</TableHead>
                <TableHead className="text-right">Aging open</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Aging net</TableHead>
                <TableHead className="text-right">Ledger net</TableHead>
                <TableHead className="text-right">Variance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.contactId ?? "unattributed"}>
                  <TableCell className="font-medium">
                    {row.contactId ? (
                      <ClickableEntity onClick={() => navigate(`/contacts/${row.contactId}`)}>
                        {row.contactName}
                      </ClickableEntity>
                    ) : (
                      row.contactName
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline">{AP_VARIANCE_REASON_LABELS[row.reason]}</Badge>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            {AP_VARIANCE_REASON_HINTS[row.reason]}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.documentCount}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.projectionOpen)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.projectionCredit > 0 ? `(${formatCurrency(row.projectionCredit)})` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.projectionNet)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.ledgerNet)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-bold text-destructive">
                    {formatCurrency(row.variance)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {(isFetching || agingFetching) && !isLoading && (
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" /> Refreshing…
        </p>
      )}
    </div>
  );
}
