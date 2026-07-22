/**
 * HistoryWorkspace — Phase-3d, route-owned surface for
 * `terminalState.phase === "history"`.
 *
 * Replaces `TransactionHistoryDialog` as the "Transaction History"
 * workstation. All summaries, filters, detail panel, void flow, and
 * reprint path move from a `<Dialog>` into a full-region `<section>`
 * so that browsing history is a first-class workstation phase — not
 * a popup overlay.
 *
 * Sub-modals that wrap driver conversations or explicit confirmation
 * captures stay modal on purpose:
 *   - `ManagerOverrideDialog` — server-driven PIN capture.
 *   - `VoidTransactionDialog` — reason + note capture; short-form.
 *
 * The reprint affordance previously had to close the outer `<Dialog>`
 * before mounting `PostPaymentSurface` so its focus trap and body
 * `pointer-events: none` lock wouldn't fight. That dance is gone —
 * the workspace is not a Dialog, so `PostPaymentSurface` can simply
 * render as a stacked full-region section on top of the history
 * grid, and dismissing it returns to the history workspace.
 *
 * Business logic — void FSM, override replay, refund/PDF flows — is
 * unchanged from the retired `TransactionHistoryDialog`.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md`.
 */

import { useState } from "react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Receipt,
  XCircle,
  CheckCircle,
  ArrowLeft,
  Printer,
  Ban,
  Download,
  FileText,
} from "lucide-react";
import { PostPaymentSurface } from "../receipt/PostPaymentSurface";
import { VoidTransactionDialog } from "@/components/pos/VoidTransactionDialog";
import { CardPaymentActions } from "@/components/pos/transaction-detail/CardPaymentActions";
import { TransactionActionMenu } from "./TransactionActionMenu";
import { printClient } from "@/services/printing/PrintClient";
import { useResolvedPrintPolicyWithDevice } from "@/hooks/useDocumentPrintPolicies";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  usePOSTransactionHistory,
  POSTransactionRecord,
} from "@/hooks/pos/usePOSTransactionHistory";
import { isOverrideRequiredError, parseOverrideRequiredPayload } from "@/hooks/pos/usePOSSecuritySettings";
import { useManagerOverride } from "@/hooks/pos/useManagerOverride";
import { ManagerOverrideDialog } from "@/components/pos/ManagerOverrideDialog";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
// parseOverrideError is applied at the card-tender edge (CardPaymentActions).
import type { EligibilityFacts } from "@/services/pos/reversal/eligibility";
import { toast } from "sonner";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type {
  ReceiptDocumentItem,
  ReceiptDocumentPayment,
} from "@/lib/pos/receipt/ReceiptDocumentModel";
import { useTerminalContext } from "../TerminalStateContext";


/**
 * Extended card-tender columns not on the base `POSTransactionRecord`
 * `payments[]` row (they come from the card FSM tables). Kept local so
 * the workspace can narrow the runtime shape without leaking a shared
 * cross-module type.
 */
type CardTenderRow = {
  id?: string;
  tender_kind?: string | null;
  payment_method?: string | null;
  auth_state?: string | null;
};

interface HistoryWorkspaceProps {
  shiftId?: string;
  registerId?: string;
}

export function HistoryWorkspace({ shiftId, registerId }: HistoryWorkspaceProps) {
  const { dispatch, state } = useTerminalContext();
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
  const pendingVoidId = pendingVoidPayload?.transactionId ?? null;

  const active = state.phase === "history";
  const close = () => {
    if (state.phase === "history") dispatch({ kind: "op", op: "closeSide" });
  };

  const [isGeneratingPdf, setIsGeneratingPdf] = React.useState(false);

  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { policy: posReceiptPolicy, device: posReceiptDevice } = useResolvedPrintPolicyWithDevice(
    currentBusiness?.id,
    null,
    "pos_receipt",
  );
  const { requestOverride, isVerifying } = useManagerOverride();

  const {
    transactions,
    isLoading,
    getTransactionDetails,
    voidTransaction,
    totalSales,
    totalReturns,
    netSales,
    transactionCount,
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

  // Reprint no longer needs to close a parent Dialog first — the
  // workspace has no focus trap. Just overlay PostPaymentSurface.
  const handleReprint = () => {
    setShowReceiptPreview(true);
  };

  const handleDownloadPdf = async (details: POSTransactionRecord) => {
    setIsGeneratingPdf(true);
    try {
      // ADR-0026 — route receipt PDF renders through PrintClient so
      // policy resolution and job telemetry stay unified.
      await printClient.print({
        intent: "receipt",
        documentType: "pos_receipt",
        documentId: details.id,
        format: "pdf",
        title: `receipt-${details.transaction_number}`,
        businessId: currentBusiness?.id ?? null,
        branchId: (currentBusiness as unknown as { branch_id?: string | null })?.branch_id ?? null,
      });
    } catch (error) {
      console.error("Failed to render receipt PDF:", error);
    } finally {
      setIsGeneratingPdf(false);
    }
  };

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
        onError: (error: unknown) => {
          if (isOverrideRequiredError(error)) {
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
    const payload = parseOverrideRequiredPayload(undefined);
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
    submitVoid(result.overrideId, {
      voidReasonId: pendingVoidPayload.voidReasonId,
      voidNote: pendingVoidPayload.voidNote,
    });
  };

  /**
   * Derive Stage 2 EligibilityFacts from a persisted transaction record.
   * Kept as a pure function so unit tests can pin the mapping — this is
   * the authoritative bridge between the DB row shape and the taxonomy.
   */
  const deriveFacts = React.useCallback(
    (tx: POSTransactionRecord): EligibilityFacts => {
      const payments = tx.payments ?? [];
      const items = tx.items ?? [];
      const cardPayments = payments.filter((p) => {
        const rec = p as unknown as { tender_kind?: string; payment_method?: string; auth_state?: string };
        return rec.tender_kind === "card" || rec.payment_method === "card" || !!rec.auth_state;
      });
      const hasAuthorizedCardTender = cardPayments.some((p) => {
        const s = (p as unknown as { auth_state?: string }).auth_state;
        return s === "approved" || s === "authorized";
      });
      const hasSettledTender = tx.status === "completed" && payments.length > 0;
      return {
        status: tx.status === "voided" ? "voided" : tx.status === "completed" ? "completed" : "pending",
        isOnCurrentShift: tx.shift_id === shiftId,
        hasSettledTender,
        hasAuthorizedCardTender,
        // POS commits are synchronous — completed => goods fulfilled.
        goodsFulfilled: tx.status === "completed",
        hasPriorReversal: tx.status === "voided",
        returnableLineCount: tx.status === "completed" ? items.length : 0,
        hasIdentifiedCustomer: !!tx.customer_id,
      };
    },
    [shiftId],
  );

  const openReturnFlow = (tx: POSTransactionRecord, kind: "return" | "exchange" | "refund" | "store_credit") => {
    close();
    dispatch({ kind: "op", op: "openReturn" });
    const label = {
      return: "Return workspace opened",
      exchange: "Return workspace opened — add replacement items in Sale",
      refund: "Return workspace opened — select items to refund",
      store_credit: "Return workspace opened — issue as store credit at checkout",
    }[kind];
    toast.info(label, {
      description: `Sale ${tx.transaction_number}`,
    });
  };

  const buildActionHandlers = (tx: POSTransactionRecord) => ({
    onVoid:         () => handleVoid(tx.id),
    onReverseCard:  () => {
      // The card FSM lives inline in the details panel below (see
      // CardPaymentActions). We just surface a hint — the buttons are
      // already visible and gated by their own state machine.
      toast.info("Use the card actions below", {
        description: "Void or Reverse the specific card tender on this sale.",
      });
    },
    onRefund:       () => openReturnFlow(tx, "refund"),
    onReturn:       () => openReturnFlow(tx, "return"),
    onExchange:     () => openReturnFlow(tx, "exchange"),
    onStoreCredit:  () => openReturnFlow(tx, "store_credit"),
  });


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

  if (!active) return null;

  return (
    <Sheet open={active} onOpenChange={(v) => !v && close()}>
      <SheetContent
        side="right"
        className="w-full p-0 sm:max-w-2xl lg:max-w-3xl xl:max-w-5xl flex flex-col"
      >
        <section
          aria-labelledby="history-workspace-title"
          className="flex-1 min-h-0 flex flex-col bg-background"
        >
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="icon" onClick={close} aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1
              id="history-workspace-title"
              className="flex items-center gap-2 text-lg font-semibold sm:text-xl truncate"
            >
              <Receipt className="h-5 w-5" />
              Transaction History
            </h1>
          </div>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
        </header>

        <ScrollArea className="flex-1 min-h-0">
          <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6 sm:py-6 space-y-4">
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

            <div className="flex flex-col lg:flex-row gap-4">
              {/* Transaction List */}
              <div className="flex-1 min-w-0">
                {isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
                    ))}
                  </div>
                ) : transactions.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Receipt className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p>No transactions found</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {transactions.map((tx) => (
                      <div
                        key={tx.id}
                        className={cn(
                          "p-3 border rounded-lg cursor-pointer transition-colors",
                          selectedTransaction?.id === tx.id
                            ? "border-primary bg-primary/5"
                            : "hover:border-primary/50",
                        )}
                        onClick={() => handleViewDetails(tx)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            {getStatusIcon(tx.status)}
                            <span className="font-medium truncate">{tx.transaction_number}</span>
                            <Badge className={cn("text-xs shrink-0", getTypeColor(tx.transaction_type))}>
                              {tx.transaction_type}
                            </Badge>
                          </div>
                          <span
                            className={cn(
                              "font-semibold shrink-0",
                              tx.transaction_type === "return" ? "text-orange-600" : "text-green-600",
                            )}
                          >
                            {tx.transaction_type === "return" ? "-" : ""}
                            {formatCurrency(tx.total)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-1 text-sm text-muted-foreground">
                          <span className="truncate">{tx.customer_name || "Walk-in"}</span>
                          <span className="shrink-0">{format(new Date(tx.created_at), "h:mm a")}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Transaction Details */}
              {transactionDetails && (
                <div className="w-full lg:w-80 border-t lg:border-t-0 lg:border-l pt-4 lg:pt-0 lg:pl-4">
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

                    {/* Wave 2 · Phase C-3.3 — post-commit card lifecycle. */}
                    {transactionDetails.payments?.some(
                      (p) => {
                        const row = p as CardTenderRow;
                        return row.tender_kind === "card" || row.payment_method === "card" || !!row.auth_state;
                      },
                    ) && (
                      <div className="space-y-2 pt-2 border-t">
                        <p className="text-muted-foreground text-xs">Card Actions</p>
                        {transactionDetails.payments
                          ?.filter((p) => {
                            const row = p as CardTenderRow;
                            return row.tender_kind === "card" || row.payment_method === "card" || !!row.auth_state;
                          })
                          .map((payment) => (
                            <CardPaymentActions
                              key={(payment as CardTenderRow).id ?? payment.payment_method}
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
                          onClick={handleReprint}
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
                              close();
                              navigate("/invoices");
                            }}
                          >
                            <FileText className="h-4 w-4 mr-1" />
                            Invoice
                          </Button>
                        )}
                        <TransactionActionMenu
                          facts={deriveFacts(transactionDetails)}
                          handlers={buildActionHandlers(transactionDetails)}
                          disabled={voidTransaction.isPending}
                        />

                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </section>

      {/* Manager Override — modal, wraps a driver conversation. */}
      <ManagerOverrideDialog
        open={showManagerOverride}
        onOpenChange={(open) => {
          setShowManagerOverride(open);
          if (!open) setPendingVoidPayload(null);
        }}
        action="void_transaction"
        originalValue={pendingVoidId ? transactions.find((t) => t.id === pendingVoidId)?.total : undefined}
        onApprove={handleOverrideApprove}
        isVerifying={isVerifying}
      />

      {/* Stage 5 — Void reason + (optional) note capture. */}
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

      {/* Reprint — full-region overlay on top of the history grid. No
          Dialog focus-trap dance because the workspace itself isn't a
          Dialog. Dismissing simply hides the overlay and returns the
          user to the history workspace they came from. */}
      {transactionDetails && showReceiptPreview && (
        <section
          aria-label="Receipt reprint"
          className="absolute inset-0 z-50 flex flex-col bg-background"
        >
          <PostPaymentSurface
            open
            isReprint
            policy={posReceiptPolicy ? {
              auto_print: posReceiptPolicy.auto_print,
              render_mode: posReceiptPolicy.render_mode,
              paper_format: posReceiptPolicy.paper_format,
            } : undefined}
            onNewSale={() => setShowReceiptPreview(false)}
            transaction={{
              id: transactionDetails.id,
              transaction_number: transactionDetails.transaction_number,
              total_amount: transactionDetails.total,
              subtotal: transactionDetails.subtotal,
              tax_amount: transactionDetails.tax_amount,
              discount_amount: transactionDetails.discount_amount,
              created_at: transactionDetails.created_at,
              customer_name: transactionDetails.customer_name ?? null,
              // Extended columns not on POSTransactionRecord but present
              // at runtime; cast through `unknown` (never `any`) so
              // strict-lint stays green while the SQL row still flows
              // through unchanged. See ReceiptDocumentModel.LiveTransactionInput.
              cashier_name:
                (transactionDetails as unknown as { cashier_name?: string | null }).cashier_name ?? null,
              register_id:
                (transactionDetails as unknown as { register_id?: string | null }).register_id
                ?? registerId ?? null,
              invoice_id: transactionDetails.invoice_id ?? null,
              invoice_number:
                (transactionDetails as unknown as { invoice_number?: string | null }).invoice_number ?? null,
              etims_cu_number:
                (transactionDetails as unknown as { etims_cu_number?: string | null }).etims_cu_number ?? null,
              etims_qr_data:
                (transactionDetails as unknown as { etims_qr_data?: string | null }).etims_qr_data ?? null,
              is_voided: transactionDetails.status === "voided",
              is_refund: transactionDetails.transaction_type === "return",
              items: (transactionDetails.items || []).map((item) => ({
                product_name: (item as unknown as { product_name?: string }).product_name || item.description || "Item",
                sku: (item as unknown as { sku?: string | null }).sku ?? undefined,
                quantity: item.quantity,
                unit_price: item.unit_price,
                discount_amount: (item as unknown as { discount_amount?: number }).discount_amount ?? 0,
                tax_rate_name:
                  (item as unknown as { tax_rate_name?: string | null }).tax_rate_name ?? null,
                line_total: item.line_total,
              })) as unknown as ReceiptDocumentItem[],
              payments: (transactionDetails.payments || []).map((p) => ({
                payment_method: p.payment_method,
                amount: p.amount,
                reference: p.reference ?? null,
              })) as unknown as ReceiptDocumentPayment[],
            }}
          />
        </section>
      )}
      </SheetContent>
    </Sheet>
  );
}

export default HistoryWorkspace;
