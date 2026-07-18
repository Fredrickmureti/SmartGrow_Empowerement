import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Search, 
  Receipt, 
  XCircle, 
  CheckCircle,
  RotateCcw,
  Eye,
  Printer,
  Ban,
  Download,
  FileText
} from "lucide-react";
import { PostPaymentScreen } from "./PostPaymentScreen";
import { VoidTransactionDialog } from "./VoidTransactionDialog";
import { CardPaymentActions } from "./transaction-detail/CardPaymentActions";
import { useDocumentPrint } from "@/hooks/useDocumentPrint";
import { useResolvedPrintPolicyWithDevice } from "@/hooks/useDocumentPrintPolicies";
import { useBusinesses } from "@/hooks/useBusinesses";
import { 
  usePOSTransactionHistory, 
  POSTransactionRecord 
} from "@/hooks/pos/usePOSTransactionHistory";
import { isOverrideRequiredError, parseOverrideRequiredPayload } from "@/hooks/pos/usePOSSecuritySettings";
import { useManagerOverride } from "@/hooks/pos/useManagerOverride";
import { ManagerOverrideDialog } from "./ManagerOverrideDialog";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface TransactionHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftId?: string;
  registerId?: string;
}

export function TransactionHistoryDialog({
  open,
  onOpenChange,
  shiftId,
  registerId,
}: TransactionHistoryDialogProps) {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedTransaction, setSelectedTransaction] = useState<POSTransactionRecord | null>(null);
  const [transactionDetails, setTransactionDetails] = useState<POSTransactionRecord | null>(null);
  const [showManagerOverride, setShowManagerOverride] = useState(false);
  const [pendingOverrideId, setPendingOverrideId] = useState<string | null>(null);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [showReceiptPreview, setShowReceiptPreview] = useState(false);
  const [pendingVoidPayload, setPendingVoidPayload] = useState<
    | { transactionId: string; voidReasonId: string; voidNote?: string; total: number }
    | null
  >(null);
  // Stage 8.6: derived — single source of truth is pendingVoidPayload
  const pendingVoidId = pendingVoidPayload?.transactionId ?? null;

  const { downloadPdf, isGeneratingPdf } = useDocumentPrint();

  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Wave 10 — device-aware resolution so reprint UI can show which physical
  // printer the receipt will land on. Base `policy` shape is unchanged.
  const { policy: posReceiptPolicy, device: posReceiptDevice } = useResolvedPrintPolicyWithDevice(
    currentBusiness?.id,
    null,
    "pos_receipt",
  );
  const { requestOverride, isVerifying } = useManagerOverride(currentOrg?.id);
  
  const { 
    transactions, 
    isLoading, 
    getTransactionDetails,
    voidTransaction,
    totalSales,
    totalReturns,
    netSales,
    transactionCount
  } = usePOSTransactionHistory({
    shiftId,
    registerId,
    searchQuery: searchQuery || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
  });

  const handleViewDetails = async (tx: POSTransactionRecord) => {
    setSelectedTransaction(tx);
    try {
      const details = await getTransactionDetails(tx.id);
      setTransactionDetails(details);
    } catch (error) {
      console.error("Failed to load transaction details:", error);
    }
  };

  const handleReprint = (details: POSTransactionRecord) => {
    // Close the parent Radix Dialog first so it releases its focus trap
    // and `pointer-events: none` lock on <body>. Then mount the full-bleed
    // PostPaymentScreen as a sibling — not a child — of <Dialog>.
    onOpenChange(false);
    setShowReceiptPreview(true);
  };

  const handleDownloadPdf = (details: POSTransactionRecord) => {
    downloadPdf(
      "pos_receipt",
      details.id,
      `receipt-${details.transaction_number}`
    );
  };

  // Stage 8.6: void path uses try-server / catch override_required / prompt PIN /
  // retry. The cashier no longer needs a client-readable flag to decide whether
  // to prompt — the server (assert_manager_override) is the single source of truth.
  const handleVoid = (id: string) => {
    const transaction = transactions.find((t) => t.id === id);
    setPendingVoidPayload({
      transactionId: id,
      voidReasonId: "",
      voidNote: undefined,
      total: transaction?.total || 0,
    });
    setPendingOverrideId(null);
    setShowVoidDialog(true);
  };

  const submitVoid = (overrideId: string | null, payload: { voidReasonId: string; voidNote?: string }) => {
    if (!pendingVoidPayload) return;
    const merged = { ...pendingVoidPayload, ...payload };
    voidTransaction.mutate(
      {
        transactionId: merged.transactionId,
        voidReasonId: merged.voidReasonId,
        voidNote: merged.voidNote,
        overrideId: overrideId ?? undefined,
      },
      {
        onSuccess: () => {
          setShowVoidDialog(false);
          setShowManagerOverride(false);
          setPendingVoidPayload(null);
          setPendingOverrideId(null);
        },
        onError: (error: any) => {
          if (isOverrideRequiredError(error)) {
            // Server says we need approval — capture the (now filled) payload
            // and open the PIN dialog. The reason is preserved for replay.
            setPendingVoidPayload({ ...merged });
            setShowVoidDialog(false);
            setShowManagerOverride(true);
          }
        },
      },
    );
  };

  const handleVoidConfirm = (input: { voidReasonId: string; voidNote?: string }) => {
    submitVoid(pendingOverrideId, input);
  };

  const handleOverrideApprove = async (pin: string, reason?: string) => {
    if (!pendingVoidPayload || !registerId) return;
    const payload = parseOverrideRequiredPayload(undefined); // no-op, kept for symmetry
    void payload;
    const result = await requestOverride({
      action: "void_above_threshold",
      pin,
      registerId,
      transactionId: pendingVoidPayload.transactionId,
      originalValue: pendingVoidPayload.total,
      reason,
    });
    setPendingOverrideId(result.overrideId);
    setShowManagerOverride(false);
    // Replay the void with the override id and the reason already captured.
    submitVoid(result.overrideId, {
      voidReasonId: pendingVoidPayload.voidReasonId,
      voidNote: pendingVoidPayload.voidNote,
    });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "voided":
        return <XCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "sale":
        return "bg-green-500/10 text-green-600";
      case "return":
        return "bg-orange-500/10 text-orange-600";
      case "exchange":
        return "bg-blue-500/10 text-blue-600";
      default:
        return "bg-muted";
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-2xl max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Receipt className="h-5 w-5" />
            Transaction History
          </DialogTitle>
        </DialogHeader>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <div className="p-2 sm:p-3 bg-muted/50 rounded-lg text-center min-w-0">
            <p className="text-xs text-muted-foreground">Transactions</p>
            <p className="text-base sm:text-lg font-semibold">{transactionCount}</p>
          </div>
          <div className="p-2 sm:p-3 bg-green-500/10 rounded-lg text-center min-w-0">
            <p className="text-xs text-muted-foreground">Sales</p>
            <p className="text-sm sm:text-lg font-semibold text-green-600 truncate">{formatCurrency(totalSales)}</p>
          </div>
          <div className="p-2 sm:p-3 bg-orange-500/10 rounded-lg text-center min-w-0">
            <p className="text-xs text-muted-foreground">Returns</p>
            <p className="text-sm sm:text-lg font-semibold text-orange-600 truncate">{formatCurrency(totalReturns)}</p>
          </div>
          <div className="p-2 sm:p-3 bg-blue-500/10 rounded-lg text-center min-w-0">
            <p className="text-xs text-muted-foreground">Net</p>
            <p className="text-sm sm:text-lg font-semibold text-blue-600 truncate">{formatCurrency(netSales)}</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by transaction # or customer..."
              className="pl-10 h-10 sm:h-9 text-base sm:text-sm"
            />
          </div>
          <Tabs value={statusFilter} onValueChange={setStatusFilter}>
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="all" className="flex-1 sm:flex-none">All</TabsTrigger>
              <TabsTrigger value="completed" className="flex-1 sm:flex-none">Completed</TabsTrigger>
              <TabsTrigger value="voided" className="flex-1 sm:flex-none">Voided</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex flex-col sm:flex-row gap-4">
          {/* Transaction List */}
          <ScrollArea className="flex-1 h-[300px] sm:h-[350px]">
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-16 bg-muted animate-pulse rounded-lg"
                  />
                ))}
              </div>
            ) : transactions.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Receipt className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>No transactions found</p>
              </div>
            ) : (
              <div className="space-y-2 pr-4">
                {transactions.map((tx) => (
                  <div
                    key={tx.id}
                    className={cn(
                      "p-3 border rounded-lg cursor-pointer transition-colors",
                      selectedTransaction?.id === tx.id
                        ? "border-primary bg-primary/5"
                        : "hover:border-primary/50"
                    )}
                    onClick={() => handleViewDetails(tx)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(tx.status)}
                        <span className="font-medium">{tx.transaction_number}</span>
                        <Badge className={cn("text-xs", getTypeColor(tx.transaction_type))}>
                          {tx.transaction_type}
                        </Badge>
                      </div>
                      <span className={cn(
                        "font-semibold",
                        tx.transaction_type === "return" ? "text-orange-600" : "text-green-600"
                      )}>
                        {tx.transaction_type === "return" ? "-" : ""}{formatCurrency(tx.total)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1 text-sm text-muted-foreground">
                      <span>{tx.customer_name || "Walk-in"}</span>
                      <span>{format(new Date(tx.created_at), "h:mm a")}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Transaction Details */}
          {transactionDetails && (
            <div className="w-full sm:w-72 border-t sm:border-t-0 sm:border-l pt-4 sm:pt-0 sm:pl-4">
              <h4 className="font-semibold mb-3">Details</h4>
              
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-muted-foreground">Transaction #</p>
                  <p className="font-medium">{transactionDetails.transaction_number}</p>
                </div>
                
                <div>
                  <p className="text-muted-foreground">Time</p>
                  <p className="font-medium">
                    {format(new Date(transactionDetails.created_at), "MMM d, h:mm a")}
                  </p>
                </div>

                <div>
                  <p className="text-muted-foreground">Items</p>
                  <div className="space-y-1 mt-1">
                    {transactionDetails.items?.map((item) => (
                      <div key={item.id} className="flex justify-between">
                        <span>
                          {item.description} ×{item.quantity}
                        </span>
                        <span>{formatCurrency(item.line_total)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{formatCurrency(transactionDetails.subtotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tax</span>
                    <span>{formatCurrency(transactionDetails.tax_amount)}</span>
                  </div>
                  {transactionDetails.discount_amount > 0 && (
                    <div className="flex justify-between text-green-600">
                      <span>Discount</span>
                      <span>-{formatCurrency(transactionDetails.discount_amount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold pt-1 border-t mt-1">
                    <span>Total</span>
                    <span>{formatCurrency(transactionDetails.total)}</span>
                  </div>
                </div>

                <div>
                  <p className="text-muted-foreground">Payment</p>
                  <div className="space-y-1 mt-1">
                    {transactionDetails.payments?.map((payment) => (
                      <div key={payment.id} className="flex justify-between">
                        <span className="capitalize">{payment.payment_method}</span>
                        <span>{formatCurrency(Math.abs(payment.amount))}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Wave 2 · Phase C-3.3 — post-commit card lifecycle. Renders
                    Capture / Void / Reverse per card tender via cardTerminal.*
                    (RPC-backed FSM). Non-card tenders are silently skipped. */}
                {transactionDetails.payments?.some(
                  (p: any) => p.tender_kind === "card" || p.payment_method === "card" || p.auth_state,
                ) && (
                  <div className="space-y-2 pt-2 border-t">
                    <p className="text-muted-foreground text-xs">Card Actions</p>
                    {transactionDetails.payments
                      ?.filter((p: any) =>
                        p.tender_kind === "card" || p.payment_method === "card" || p.auth_state,
                      )
                      .map((payment: any) => (
                        <CardPaymentActions
                          key={payment.id}
                          payment={payment}
                          registerId={registerId}
                          onChanged={async () => {
                            const refreshed = await getTransactionDetails(transactionDetails.id);
                            setTransactionDetails(refreshed);
                          }}
                        />
                      ))}
                  </div>
                )}

                {transactionDetails.status === "completed" && (
                  <div className="flex gap-2 pt-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleReprint(transactionDetails)}
                      // Wave 10 — surface the resolved device on hover so an
                      // operator about to reprint knows exactly which printer
                      // will fire (and can re-bind in Hardware if it's wrong).
                      title={posReceiptDevice
                        ? `Reprint to ${posReceiptDevice.display_name ?? `${posReceiptDevice.role} (${posReceiptDevice.transport})`}`
                        : posReceiptPolicy.printer_profile_id
                          ? "Reprint — no device bound to the configured printer profile"
                          : "Reprint"}
                    >
                      <Printer className="h-4 w-4 mr-1" />
                      Reprint
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleDownloadPdf(transactionDetails)}
                      disabled={isGeneratingPdf}
                    >
                      <Download className="h-4 w-4 mr-1" />
                      PDF
                    </Button>
                    {transactionDetails.invoice_id && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => {
                          onOpenChange(false);
                          navigate("/invoices");
                        }}
                      >
                        <FileText className="h-4 w-4 mr-1" />
                        Invoice
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-destructive hover:text-destructive"
                      onClick={() => handleVoid(transactionDetails.id)}
                      disabled={voidTransaction.isPending}
                    >
                      <Ban className="h-4 w-4 mr-1" />
                      Void
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
      
      {/* Manager Override Dialog */}
      <ManagerOverrideDialog
        open={showManagerOverride}
        onOpenChange={(open) => {
          setShowManagerOverride(open);
          if (!open) setPendingVoidPayload(null);
        }}
        action="void_transaction"
        originalValue={pendingVoidId ? transactions.find(t => t.id === pendingVoidId)?.total : undefined}
        onApprove={handleOverrideApprove}
        isVerifying={isVerifying}
      />

      {/* Stage 5 — Void reason + (optional) note capture */}
      <VoidTransactionDialog
        open={showVoidDialog}
        onOpenChange={(open) => {
          setShowVoidDialog(open);
          if (!open) {
            setPendingVoidPayload(null);
            setPendingOverrideId(null);
          }
        }}
        transactionNumber={
          pendingVoidId
            ? transactions.find((t) => t.id === pendingVoidId)?.transaction_number
            : undefined
        }
        isSubmitting={voidTransaction.isPending}
        onConfirm={handleVoidConfirm}
      />
    </Dialog>

    {/* Reprint — full-bleed PostPaymentScreen rendered OUTSIDE the Radix
        Dialog tree so it does not inherit the dialog's focus trap or
        body `pointer-events: none` lock. Parent dialog is closed first by
        handleReprint; New Sale re-opens it. */}
    {transactionDetails && showReceiptPreview && (
        <PostPaymentScreen
          open={showReceiptPreview}
          isReprint
          policy={posReceiptPolicy ? {
            auto_print: posReceiptPolicy.auto_print,
            render_mode: posReceiptPolicy.render_mode,
            paper_format: posReceiptPolicy.paper_format,
          } : undefined}
          onNewSale={() => {
            setShowReceiptPreview(false);
            onOpenChange(true);
          }}
          transaction={{
            id: transactionDetails.id,
            transaction_number: transactionDetails.transaction_number,
            total_amount: transactionDetails.total,
            subtotal: transactionDetails.subtotal,
            tax_amount: transactionDetails.tax_amount,
            discount_amount: transactionDetails.discount_amount,
            created_at: transactionDetails.created_at,
            customer_name: transactionDetails.customer_name ?? null,
            cashier_name: (transactionDetails as any).cashier_name ?? null,
            register_id: (transactionDetails as any).register_id ?? registerId ?? null,
            invoice_id: transactionDetails.invoice_id ?? null,
            invoice_number: (transactionDetails as any).invoice_number ?? null,
            etims_cu_number: (transactionDetails as any).etims_cu_number ?? null,
            etims_qr_data: (transactionDetails as any).etims_qr_data ?? null,
            is_voided: transactionDetails.status === "voided",
            is_refund: transactionDetails.transaction_type === "return",
            items: (transactionDetails.items || []).map((item: any) => ({
              product_name: item.product_name || item.description || "Item",
              sku: item.sku ?? undefined,
              quantity: item.quantity,
              unit_price: item.unit_price,
              discount_amount: item.discount_amount ?? 0,
              tax_rate_name: item.tax_rate_name ?? null,
              line_total: item.line_total,
            })) as any,
            payments: (transactionDetails.payments || []).map((p: any) => ({
              payment_method: p.payment_method,
              amount: p.amount,
              reference: p.reference ?? null,
            })) as any,
          }}
        />
      )}
    </>
  );
}
