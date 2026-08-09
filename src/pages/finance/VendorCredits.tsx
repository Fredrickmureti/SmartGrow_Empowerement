/**
 * Vendor Credits — the AP mirror of Customer Credits (ADR 0028, D6.1).
 *
 * Operator surface for supplier cash that has left the bank but is not yet
 * matched to a bill. Reads `vendor_unapplied_advances` via
 * `useVendorUnappliedAdvances` — the single source of truth for AP unapplied
 * cash. Never re-derives the split by summing `bill_payment_allocations`.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Loader2,
  Search,
  Users,
  Wallet,
  ChevronDown,
  ChevronRight,
  Plus,
  ArrowRight,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { useCurrency } from "@/hooks/useCurrency";
import {
  useVendorUnappliedAdvances,
  type UnappliedVendorAdvance,
} from "@/hooks/useVendorUnappliedAdvances";
import { RecordVendorAdvanceDialog } from "@/components/payments/RecordVendorAdvanceDialog";
import { ApplyVendorAdvanceDialog } from "@/components/payments/ApplyVendorAdvanceDialog";

interface VendorGroup {
  vendor_id: string;
  vendor_name: string;
  total_paid: number;
  total_applied: number;
  total_available: number;
  advances: UnappliedVendorAdvance[];
}

export default function VendorCredits() {
  const { formatCurrency } = useCurrency();
  const queryClient = useQueryClient();
  const { advances, totalUnapplied, isLoading } = useVendorUnappliedAdvances();

  const [searchQuery, setSearchQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [recordOpen, setRecordOpen] = useState(false);
  const [applyFor, setApplyFor] = useState<{ vendorId: string; advanceId?: string } | null>(null);

  const groups = useMemo<VendorGroup[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const byVendor = new Map<string, VendorGroup>();

    for (const a of advances) {
      if (!a.vendor_id) continue;
      const name = a.vendor_name ?? "Unknown supplier";
      if (q && !name.toLowerCase().includes(q) && !(a.reference ?? "").toLowerCase().includes(q)) {
        continue;
      }
      const g = byVendor.get(a.vendor_id) ?? {
        vendor_id: a.vendor_id,
        vendor_name: name,
        total_paid: 0,
        total_applied: 0,
        total_available: 0,
        advances: [],
      };
      g.total_paid += a.amount;
      g.total_applied += a.applied_amount;
      g.total_available += a.outstanding_amount;
      g.advances.push(a);
      byVendor.set(a.vendor_id, g);
    }

    return Array.from(byVendor.values()).sort((x, y) => y.total_available - x.total_available);
  }, [advances, searchQuery]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const totalPaid = advances.reduce((s, a) => s + a.amount, 0);
  const totalApplied = advances.reduce((s, a) => s + a.applied_amount, 0);

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ["vendor-unapplied-advances"] });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Vendor Credits</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Supplier advances and overpayments that have left the bank but are not yet
            applied to a bill
          </p>
          <div className="mt-2">
            <FinanceScopeBadge />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            queryKeyPrefixes={[["vendor-unapplied-advances"] as const, ["bills"] as const]}
            tooltip="Refresh vendor credits"
          />
          <Button onClick={() => setRecordOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Record Advance
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Advances Paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold tabular-nums">{formatCurrency(totalPaid)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {advances.length} payment{advances.length !== 1 ? "s" : ""} with open balance
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Applied to Bills
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-emerald-600 tabular-nums">
              {formatCurrency(totalApplied)}
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-primary">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Unapplied Credit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-primary tabular-nums">
              {formatCurrency(totalUnapplied)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              <Wallet className="h-3 w-3 inline mr-1" />
              Held on Vendor Credits
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Suppliers with Credit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold tabular-nums">{groups.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              <Users className="h-3 w-3 inline mr-1" />
              Active balances
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search supplier or reference…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {groups.length === 0 ? (
            <div className="py-16 text-center">
              <Wallet className="h-8 w-8 mx-auto text-muted-foreground/50" />
              <p className="mt-3 text-sm text-muted-foreground">
                No unapplied supplier credit.
              </p>
              <Button variant="outline" className="mt-4" onClick={() => setRecordOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" />
                Record an advance
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {groups.map((g) => (
                <Collapsible
                  key={g.vendor_id}
                  open={expanded.has(g.vendor_id)}
                  onOpenChange={() => toggle(g.vendor_id)}
                >
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <CollapsibleTrigger className="flex items-center gap-2 flex-1 text-left">
                      {expanded.has(g.vendor_id) ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="font-medium">{g.vendor_name}</span>
                      <Badge variant="secondary">
                        {g.advances.length} advance{g.advances.length !== 1 ? "s" : ""}
                      </Badge>
                    </CollapsibleTrigger>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-sm font-semibold tabular-nums text-primary">
                          {formatCurrency(g.total_available)}
                        </div>
                        <div className="text-xs text-muted-foreground">available</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setApplyFor({ vendorId: g.vendor_id })}
                      >
                        Apply
                        <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                      </Button>
                    </div>
                  </div>

                  <CollapsibleContent>
                    <div className="px-4 pb-4">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead>Reference</TableHead>
                            <TableHead>Method</TableHead>
                            <TableHead className="text-right">Paid</TableHead>
                            <TableHead className="text-right">Applied</TableHead>
                            <TableHead className="text-right">Available</TableHead>
                            <TableHead />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {g.advances.map((a) => (
                            <TableRow key={a.id}>
                              <TableCell>
                                {format(parseISO(a.payment_date), "dd MMM yyyy")}
                              </TableCell>
                              <TableCell>{a.reference || "—"}</TableCell>
                              <TableCell className="capitalize">
                                {(a.payment_method ?? "—").replace(/_/g, " ")}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatCurrency(a.amount)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-emerald-600">
                                {formatCurrency(a.applied_amount)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums font-medium">
                                {formatCurrency(a.outstanding_amount)}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    setApplyFor({ vendorId: g.vendor_id, advanceId: a.id })
                                  }
                                >
                                  Apply
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <RecordVendorAdvanceDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        onSuccess={handleSuccess}
      />

      <ApplyVendorAdvanceDialog
        vendorId={applyFor?.vendorId ?? null}
        initialBillPaymentId={applyFor?.advanceId}
        open={!!applyFor}
        onOpenChange={(o) => !o && setApplyFor(null)}
        onSuccess={handleSuccess}
      />
    </div>
  );
}
