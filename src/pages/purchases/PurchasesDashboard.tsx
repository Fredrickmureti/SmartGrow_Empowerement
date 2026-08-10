import { useState, useEffect } from "react";
import { isBillOverdue } from "@/features/purchases/bills/billStatus";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ShoppingCart, FileText, ArrowRight, AlertCircle, Clock, RotateCcw, Package, TrendingUp } from "lucide-react";
import { useBills } from "@/hooks/useBills";
import { usePurchaseOrders } from "@/hooks/usePurchaseOrders";
import { useRFQs } from "@/hooks/useRFQs";
import { usePurchaseReturns } from "@/hooks/usePurchaseReturns";
import { useCurrency } from "@/hooks/useCurrency";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { differenceInDays, parseISO } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useDashboardComposition } from "@/hooks/useDashboardComposition";

/**
 * Purchases Module Dashboard — Bill pipeline, PO pipeline, AP aging, vendor spend
 */
// SCOPE-TRIGGER-EXEMPT: header copy references scope switching; actual switcher lives in the sidebar via SidebarContextSwitcher
export default function PurchasesDashboard() {
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { bills, isLoading: billsLoading } = useBills();
  const { purchaseOrders, isLoading: posLoading } = usePurchaseOrders();
  const { rfqs, isLoading: rfqsLoading } = useRFQs();
  const { purchaseReturns, isLoading: returnsLoading } = usePurchaseReturns();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const composition = useDashboardComposition();

  const isLoading = billsLoading || posLoading || rfqsLoading || returnsLoading;

  // Bill pipeline
  const draftBills = bills.filter(b => b.status === "draft");
  const receivedBills = bills.filter(b => b.status === "received");
  // Overdue is derived from due date + balance (Step 2b), never stored.
  const overdueBills = bills.filter(b => isBillOverdue(b));
  const paidBills = bills.filter(b => b.status === "paid");
  const outstandingBills = bills.filter(b => ["received", "partial", "overdue"].includes(b.status));
  const totalPayable = outstandingBills.reduce((s, b) => s + (b.total - (b.amount_paid || 0)), 0);

  // PO pipeline
  const draftPOs = purchaseOrders.filter(po => po.status === "draft");
  const sentPOs = purchaseOrders.filter(po => po.status === "sent");
  const partialPOs = purchaseOrders.filter(po => po.status === "partial_received");
  const receivedPOs = purchaseOrders.filter(po => po.status === "received");

  // Phase C.7 — Odoo's two distinct KPIs:
  //   "To Bill"          = committed spend that has been received
  //                        but not yet billed (billing_status='to_bill').
  //   "Awaiting Receipt" = open PO value still in the receipt pipeline
  //                        (status in draft/sent/partial_received).
  // The previous single "Open PO Value" double-counted billed POs.
  const toBillValue = purchaseOrders
    .filter(po => (po as any).billing_status === "to_bill")
    .reduce((s, po) => s + po.total, 0);
  const awaitingReceiptValue = purchaseOrders
    .filter(po => ["draft", "sent", "partial_received"].includes(po.status))
    .reduce((s, po) => s + po.total, 0);

  // RFQs
  const pendingRFQs = rfqs.filter((r: any) => r.status === "draft" || r.status === "sent");

  // Returns
  const pendingReturns = purchaseReturns.filter(r => r.status === "pending");

  // This month's expenses
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthPaid = paidBills.filter(b => new Date(b.bill_date) >= monthStart);
  const thisMonthExpenses = thisMonthPaid.reduce((s, b) => s + b.total, 0);

  // AP Aging buckets (kept client-side for the dashboard summary tile;
  // the full server-side per-vendor breakdown lives on /aged-payables).
  const agingBuckets = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
  outstandingBills.forEach(b => {
    const balance = b.total - (b.amount_paid || 0);
    const days = differenceInDays(now, parseISO(b.due_date));
    if (days <= 0) agingBuckets.current += balance;
    else if (days <= 30) agingBuckets.d30 += balance;
    else if (days <= 60) agingBuckets.d60 += balance;
    else if (days <= 90) agingBuckets.d90 += balance;
    else agingBuckets.over90 += balance;
  });

  // Phase B.4 — Top vendors by ACCRUAL spend (last 90 days), via the
  // get_top_vendor_spend RPC. Eliminates the previous client-side
  // aggregation that (a) used paid bills only — wrong on accrual basis —
  // and (b) silently truncated at 1000 rows.
  const [topVendors, setTopVendors] = useState<
    { id: string | null; name: string; total: number; bill_count: number }[]
  >([]);
  useEffect(() => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setTopVendors([]);
      return;
    }
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 90);
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("get_top_vendor_spend" as any, {
        p_organization_id: currentOrg.id,
        p_business_id: currentBusiness.id,
        p_from: fmt(from),
        p_to: fmt(to),
        p_branch_id: currentBranch?.id ?? null,
        p_limit: 5,
      });
      if (cancelled) return;
      if (error) {
        console.error("get_top_vendor_spend failed:", error);
        setTopVendors([]);
        return;
      }
      const rows = Array.isArray(data) ? data : [];
      setTopVendors(
        rows.map((r: any) => ({
          id: r.vendor_id || null,
          name: r.vendor_name || "Unknown",
          total: Number(r.total_spent || 0),
          bill_count: Number(r.bill_count || 0),
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Purchases Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Vendor bills, purchase orders, and expense tracking
          </p>
        </div>
        {/* Branch scope chip — surfaces that KPIs are branch-filtered to avoid
            HQ users mistaking a branch view for consolidated numbers. Switch
            branches via the workspace selector to change scope. */}
        <Badge variant={currentBranch ? "secondary" : "outline"} className="gap-1.5">
          <span className="text-xs">Scope:</span>
          <span className="font-medium">
            {currentBranch ? currentBranch.name : "All branches (HQ)"}
          </span>
        </Badge>
      </div>

      {/* Overdue Alert */}
      {overdueBills.length > 0 && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-destructive text-base">
              <AlertCircle className="h-5 w-5" />
              {overdueBills.length} Overdue Bill{overdueBills.length !== 1 ? "s" : ""} — {formatCurrency(overdueBills.reduce((s, b) => s + (b.total - (b.amount_paid || 0)), 0))} outstanding
            </CardTitle>
          </CardHeader>
        </Card>
      )}

      {/* KPI Cards — gated by purchases.kpis (cashier/sales hidden) */}
      {composition.allowsWidget("purchases.kpis") && (
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-l-4 border-l-emerald-500">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Expenses This Month</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(thisMonthExpenses)}</div>
            <p className="text-xs text-muted-foreground mt-1">{thisMonthPaid.length} paid bills</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-amber-500" onClick={() => navigate("/purchases/bills")}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Outstanding Payable</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(totalPayable)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {overdueBills.length > 0 ? (
                <span className="text-destructive">{overdueBills.length} overdue</span>
              ) : (
                "No overdue bills"
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-500" onClick={() => navigate("/purchases/orders")}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">To Bill</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(toBillValue)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Awaiting receipt: {formatCurrency(awaitingReceiptValue)}
            </p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-purple-500" onClick={() => navigate("/purchases/rfqs")}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Pending RFQs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{pendingRFQs.length}</div>
            <p className="text-xs text-muted-foreground mt-1">awaiting response</p>
          </CardContent>
        </Card>
      </div>
      )}

      {/* AP Aging + PO Pipeline side by side — AP aging gated by purchases.aging */}
      {composition.allowsWidget("purchases.aging") && (
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        {/* AP Aging */}
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => navigate("/purchases/aged-payables")}>
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              AP Aging Summary
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </CardTitle>
            <CardDescription>Outstanding payables by age</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                { label: "Current", value: agingBuckets.current, color: "bg-emerald-500" },
                { label: "1–30 days", value: agingBuckets.d30, color: "bg-amber-500" },
                { label: "31–60 days", value: agingBuckets.d60, color: "bg-orange-500" },
                { label: "61–90 days", value: agingBuckets.d90, color: "bg-red-400" },
                { label: "90+ days", value: agingBuckets.over90, color: "bg-destructive" },
              ].map(bucket => (
                <div key={bucket.label} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`h-2.5 w-2.5 rounded-full ${bucket.color}`} />
                    <span className="text-sm">{bucket.label}</span>
                  </div>
                  <span className="text-sm font-medium tabular-nums">{formatCurrency(bucket.value)}</span>
                </div>
              ))}
              <div className="border-t pt-2 flex items-center justify-between font-semibold">
                <span className="text-sm">Total</span>
                <span className="text-sm tabular-nums">{formatCurrency(totalPayable)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* PO Pipeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Purchase Order Pipeline</CardTitle>
            <CardDescription>Status breakdown of purchase orders</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/orders?status=draft")}>
                <div className="text-2xl font-bold">{draftPOs.length}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                  <Clock className="h-3 w-3" /> Draft
                </div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/orders?status=sent")}>
                <div className="text-2xl font-bold">{sentPOs.length}</div>
                <div className="text-xs text-muted-foreground mt-1">Sent</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/orders?status=partial_received")}>
                <div className="text-2xl font-bold text-amber-600">{partialPOs.length}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                  <Package className="h-3 w-3" /> Partial
                </div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/orders?status=received")}>
                <div className="text-2xl font-bold text-emerald-600">{receivedPOs.length}</div>
                <div className="text-xs text-muted-foreground mt-1">Received</div>
              </div>
      </div>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Bill Pipeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bill Pipeline</CardTitle>
          <CardDescription>Status breakdown of vendor bills</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/bills?status=draft")}>
              <div className="text-2xl font-bold">{draftBills.length}</div>
              <div className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                <Clock className="h-3 w-3" /> Draft
              </div>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/bills?status=received")}>
              <div className="text-2xl font-bold">{receivedBills.length}</div>
              <div className="text-xs text-muted-foreground mt-1">Received</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/bills?status=overdue")}>
              <div className="text-2xl font-bold text-destructive">{overdueBills.length}</div>
              <div className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                <AlertCircle className="h-3 w-3" /> Overdue
              </div>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/bills?status=paid")}>
              <div className="text-2xl font-bold text-emerald-600">{paidBills.length}</div>
              <div className="text-xs text-muted-foreground mt-1">Paid</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => navigate("/purchases/returns")}>
              <div className="text-2xl font-bold text-amber-600">{pendingReturns.length}</div>
              <div className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                <RotateCcw className="h-3 w-3" /> Returns
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Top Vendors */}
      {topVendors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Top Vendors by Spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topVendors.map((vendor, i) => (
                <div key={vendor.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-muted-foreground w-4">{i + 1}</span>
                    {vendor.id ? (
                      <ClickableEntity onClick={() => setPreviewContactId(vendor.id)}>
                        {vendor.name}
                      </ClickableEntity>
                    ) : (
                      <span className="text-sm font-medium">{vendor.name}</span>
                    )}
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{formatCurrency(vendor.total)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/purchases/bills")}>
              Bills <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/purchases/orders")}>
              Purchase Orders <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/purchases/expenses")}>
              Expenses <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/purchases/suppliers")}>
              Suppliers <ArrowRight className="h-3 w-3 ml-1" />
            </Button>

            <Button variant="outline" size="sm" onClick={() => navigate("/purchases/rfqs")}>
              RFQs <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/purchases/returns")}>
              Returns <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>

    <ContactPreviewDrawer
      open={!!previewContactId}
      onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
      contactId={previewContactId}
    />
    </>
  );
}
