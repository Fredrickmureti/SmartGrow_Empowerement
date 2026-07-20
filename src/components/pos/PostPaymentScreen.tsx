import { normalizeError } from "@/services/resilience";
/**
 * Stage X3+ — Post-payment success screen (cashier-first).
 *
 * Replaces the previous 3-pane overlay (payment summary + always-visible
 * receipt preview + action stack) with a fast confirmation aimed at
 * high-volume cashiers:
 *
 *   - One large "Payment received / Change due" tile.
 *   - One inline status pill (Auto-printed / Printing / Failed / Ready).
 *   - One primary action: New sale (Enter).
 *   - One secondary action: Print / Retry print (only when relevant).
 *   - All receipt details (full thermal preview, Save PDF, Email, Reprint,
 *     printer reconnect) live in a collapsible "Receipt details" panel.
 *
 * Auto-print fires silently when policy resolves to ESC/POS + auto_print +
 * a connected receipt printer. Hotkeys: Enter = New sale, R = reprint /
 * retry, P = same as R, Esc = New sale, D = toggle details panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { format } from "date-fns";
import {
  Check,
  Printer,
  RefreshCw,
  FileDown,
  Mail,
  X,
  Loader2,
  WifiOff,
  AlertTriangle,
  MoreHorizontal,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDocumentBranding } from "@/hooks/useDocumentBranding";
import { useMergedReceiptSettings } from "@/hooks/pos/useMergedReceiptSettings";
import { useReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";
import { useHardwareProxy } from "@/hooks/hardware/useHardwareProxy";
import {
  buildReceiptDocument,
  type LiveTransactionInput,
} from "@/lib/pos/receipt/ReceiptDocumentModel";
import {
  showSuccessOnCustomerDisplay,
  type ReceiptPaperWidth,
} from "@/lib/pos/receipt/renderers";
import { buildReceiptLines } from "@/lib/receipt/preview/buildReceiptLines";
import { MonospacePreview } from "@/lib/receipt/preview/MonospacePreview";
import { printClient } from "@/services/printing/PrintClient";
import { downloadPdfBlob, printPdfInPage } from "@/services/printing/pdfUtils";
import { TransactionSummaryView } from "@/components/pos/TransactionSummaryView";

export type PrintPolicyHint = {
  auto_print: boolean;
  render_mode: "pdf" | "escpos";
  paper_format: "58mm" | "80mm" | "40mm" | "a4" | "a5" | "letter" | "custom";
};

interface PostPaymentScreenProps {
  transaction: LiveTransactionInput | null;
  open: boolean;
  onNewSale: () => void;
  onEmail?: () => void;
  /** Effective per-tenant policy from useResolvedPrintPolicy. */
  policy?: PrintPolicyHint;
  /** Mark this mount as a reprint (stamps watermark, skips auto-print, opens details). */
  isReprint?: boolean;
}

type PrintState =
  | { kind: "idle" }
  | { kind: "printing" }
  | { kind: "printed"; channel: "thermal" | "pdf" }
  | { kind: "failed"; message: string };

export function PostPaymentScreen({
  transaction,
  open,
  onNewSale,
  onEmail,
  policy,
  isReprint = false,
}: PostPaymentScreenProps) {
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { branding } = useDocumentBranding(
    currentBusiness?.id ?? null,
    currentBranch?.id ?? null,
  );
  const { mergedSettings: liveSettings } = useMergedReceiptSettings();
  const { data: snapshot } = useReceiptSnapshot(transaction?.id);
  const {
    printerStatus,
    isRoleAvailable,
    printRawBytes,
    updateDisplay,
    reconnectRole,
    deviceStatuses,
    agentAvailable,
    devices,
  } = useHardwareProxy(transaction?.register_id ?? undefined, {
    passive: isReprint,
  });

  const [printState, setPrintState] = useState<PrintState>({ kind: "idle" });
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  // Reprints land directly in the "details" view so the operator can pick a
  // copy / channel. Normal sales open in the fast confirmation view.
  const [showDetails, setShowDetails] = useState(isReprint);
  const autoPrintAttemptedRef = useRef(false);

  const paperWidth: ReceiptPaperWidth =
    policy?.paper_format === "40mm" ? "40mm"
      : policy?.paper_format === "58mm" ? "58mm"
      : "80mm";

  const model = useMemo(() => {
    if (!transaction) return null;
    return buildReceiptDocument({
      snapshot: snapshot ?? null,
      live: transaction,
      liveSettings,
      liveBranding: {
        business_name: branding?.name || currentOrg?.name || "Store",
        logo_url: branding?.logo_url ?? null,
        address: branding?.address ?? null,
        city: branding?.city ?? null,
        phone: branding?.phone ?? null,
        email: branding?.email ?? null,
        tax_id: null,
      },
      isReprint,
    });
  }, [transaction, snapshot, liveSettings, branding, currentOrg, isReprint]);

  // A registered network receipt printer + an online local agent is enough
  // to *attempt* thermal. We only fall back to PDF when an actual print
  // call fails — a transient cached-status flap no longer hijacks routing.
  const hasNetworkReceiptPrinter = useMemo(() => {
    return devices.some((d) => {
      const role = (d.device_role || d.hardware_type) as string;
      const ct = ((d.connection_params as Record<string, unknown> | null)?.connection_type as string)
        || (d as unknown as { connection_type?: string }).connection_type
        || '';
      return d.is_active && role === 'receipt_printer' && ct === 'network';
    });
  }, [devices]);

  const thermalAvailable =
    printerStatus() === "connected"
    || isRoleAvailable("receipt_printer")
    || (agentAvailable && hasNetworkReceiptPrinter);

  const printerOfflineReason = useMemo(() => {
    for (const info of deviceStatuses.values()) {
      if (info.role === "receipt_printer" && !info.connected) {
        return info.lastError || `Printer status: ${info.status}`;
      }
    }
    return null;
  }, [deviceStatuses]);

  const hasReceiptPrinterRegistered = useMemo(() => {
    for (const info of deviceStatuses.values()) {
      if (info.role === "receipt_printer") return true;
    }
    return false;
  }, [deviceStatuses]);

  const renderAndShowPdf = useCallback(async () => {
    if (!model) return;
    try {
      const blob = await printClient.renderReceiptPdfBlob(model.meta.transaction_id);
      await printPdfInPage(blob);
      setPrintState({ kind: "printed", channel: "pdf" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "PDF print failed";
      setPrintState({ kind: "failed", message });
      toast({ title: "Print failed", description: message, variant: "destructive" });
    }
  }, [model, toast]);

  const handlePrint = useCallback(async () => {
    if (!model) return;
    setPrintState({ kind: "printing" });
    try {
      if (thermalAvailable) {
        const res = await printClient.printReceiptThermal({
          transactionId: model.meta.transaction_id,
          printRawBytes,
        });
        if (res.success) {
          setPrintState({ kind: "printed", channel: "thermal" });
          return;
        }
        const errMsg = res.error || "Thermal print failed";
        setPrintState({ kind: "failed", message: errMsg });
        toast({
          title: "Receipt printer failed",
          description: errMsg,
          variant: "destructive",
        });
        return;
      }
      // No thermal printer at all → server PDF in-page.
      const blob = await printClient.renderReceiptPdfBlob(model.meta.transaction_id);
      await printPdfInPage(blob);
      setPrintState({ kind: "printed", channel: "pdf" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Print failed";
      setPrintState({ kind: "failed", message });
      toast({ title: "Print failed", description: message, variant: "destructive" });
    }
  }, [model, thermalAvailable, printRawBytes, toast]);

  const handleReconnectPrinter = useCallback(async () => {
    const res = await reconnectRole("receipt_printer");
    if (res.success) {
      toast({ title: "Printer reconnected", description: "Try printing again." });
    } else {
      toast({
        title: "Reconnect failed",
        description: res.error || "Unknown error",
        variant: "destructive",
      });
    }
  }, [reconnectRole, toast]);

  const handleSavePdf = useCallback(async () => {
    if (!model) return;
    setIsSavingPdf(true);
    try {
      const blob = await printClient.renderReceiptPdfBlob(model.meta.transaction_id);
      downloadPdfBlob(blob, `receipt-${model.meta.transaction_number}.pdf`);
      toast({ title: "Receipt saved", description: "PDF downloaded" });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? normalizeError(err).message : "PDF generation failed",
        variant: "destructive",
      });
    } finally {
      setIsSavingPdf(false);
    }
  }, [model, toast]);

  // Auto-print on mount when policy says so.
  useEffect(() => {
    if (!open || !model || isReprint) return;
    if (autoPrintAttemptedRef.current) return;
    if (!policy?.auto_print) return;
    if (policy.render_mode !== "escpos") return;
    if (!thermalAvailable) return;
    autoPrintAttemptedRef.current = true;
    void handlePrint();
  }, [open, model, policy, thermalAvailable, isReprint, handlePrint]);

  // Customer display push (once per transaction).
  const customerDisplayPushedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !model || isReprint) return;
    if (customerDisplayPushedRef.current === model.meta.transaction_id) return;
    customerDisplayPushedRef.current = model.meta.transaction_id;
    void showSuccessOnCustomerDisplay(model, updateDisplay);
  }, [open, model, updateDisplay, isReprint]);

  // Hotkeys: Enter = New sale, R/P = print/retry, Esc = New sale, D = toggle details.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        onNewSale();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onNewSale();
      } else if (e.key === "r" || e.key === "R" || e.key === "p" || e.key === "P") {
        e.preventDefault();
        if (printState.kind !== "printing") void handlePrint();
      } else if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        setShowDetails((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, handlePrint, onNewSale, printState.kind]);

  if (!open || !transaction || !model) return null;

  const channelLabel =
    printState.kind === "printed"
      ? printState.channel === "thermal"
        ? "Receipt printed"
        : "Printed via PDF"
      : null;

  const showRetry = printState.kind === "failed";
  const showReprint = printState.kind === "printed" || isReprint;
  const isPrinting = printState.kind === "printing";

  return (
    <div
      role="dialog"
      aria-label="Transaction complete"
      data-testid="post-payment-screen"
      className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm overflow-y-auto"
    >
      <div className="min-h-full flex items-start sm:items-center justify-center p-3 sm:p-6">
        <div className="w-full max-w-2xl">
          {/* SINGLE CONFIRMATION CARD — preview + extra actions live in
              the side Sheet so we never split the cashier's attention
              across multiple panels. */}
          <Card className="p-6 sm:p-8 shadow-lg">
            <div className="flex items-center gap-4 mb-6">
              <div className="h-14 w-14 rounded-full bg-green-500/15 text-green-600 flex items-center justify-center shrink-0">
                <Check className="h-8 w-8" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-xl sm:text-2xl font-semibold">Payment received</h2>
                <p className="text-xs text-muted-foreground truncate">
                  {model.meta.title} · {model.meta.transaction_number}
                </p>
              </div>
              <PrintStatusPill state={printState} channelLabel={channelLabel} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">
                  Total paid
                </div>
                <div className="text-3xl sm:text-4xl font-bold tabular-nums mt-1">
                  {formatCurrency(model.totals.total_amount)}
                </div>
              </div>
              {model.totals.change_due > 0 ? (
                <div className="rounded-lg border-2 border-green-500/40 bg-green-500/5 p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Change due
                  </div>
                  <div className="text-3xl sm:text-4xl font-bold text-green-600 tabular-nums mt-1">
                    {formatCurrency(model.totals.change_due)}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Tendered
                  </div>
                  <div className="text-2xl sm:text-3xl font-bold tabular-nums mt-1">
                    {formatCurrency(model.totals.amount_tendered)}
                  </div>
                </div>
              )}
            </div>

            {/* Payment method chips */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {model.payments.map((p, i) => (
                <Badge key={i} variant="secondary" className="capitalize">
                  {p.payment_method.toLowerCase().includes("mpesa")
                    ? "M-Pesa"
                    : p.payment_method}{" "}
                  · {formatCurrency(p.amount)}
                </Badge>
              ))}
              {model.flags.is_offline && (
                <Badge variant="outline" className="border-amber-500/40 text-amber-600">
                  <WifiOff className="h-3 w-3 mr-1" /> Offline
                </Badge>
              )}
            </div>

            {/* Printer offline guidance — only when actually relevant */}
            {hasReceiptPrinterRegistered && !thermalAvailable && (
              <div className="flex flex-wrap items-center gap-2 text-xs rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 p-3 border border-amber-500/20 mb-4">
                <WifiOff className="h-4 w-4 shrink-0" />
                <span className="flex-1 min-w-0">
                  Receipt printer offline — {printerOfflineReason ?? "not responding"}.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={handleReconnectPrinter}
                >
                  <RefreshCw className="h-3 w-3 mr-1" /> Reconnect
                </Button>
              </div>
            )}

            {/* Action row — ONE primary, compact icon-button row, overflow menu */}
            <div className="flex items-center gap-2">
              <Button
                autoFocus
                size="lg"
                className="h-14 text-base flex-1"
                onClick={onNewSale}
              >
                <X className="h-5 w-5 mr-2" />
                New sale
                <kbd className="hidden sm:inline ml-auto px-1.5 py-0.5 text-xs bg-background/20 rounded">
                  Enter
                </kbd>
              </Button>

              {/* Print / retry — single icon button, label switches by state */}
              <Button
                size="lg"
                variant={showRetry ? "destructive" : "outline"}
                className="h-14 px-4"
                onClick={handlePrint}
                disabled={isPrinting}
                aria-label={showRetry ? "Retry print" : showReprint ? "Reprint" : "Print receipt"}
                title={`${showRetry ? "Retry print" : showReprint ? "Reprint" : "Print"} (P)`}
              >
                {isPrinting ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : showRetry || showReprint ? (
                  <RefreshCw className="h-5 w-5" />
                ) : (
                  <Printer className="h-5 w-5" />
                )}
              </Button>

              {/* Overflow — Show preview / Email / Save PDF / Save raw bytes */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="lg"
                    variant="outline"
                    className="h-14 px-4"
                    aria-label="More actions"
                    title="More actions"
                  >
                    <MoreHorizontal className="h-5 w-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => setShowDetails(true)}>
                    <Receipt className="h-4 w-4 mr-2" />
                    Show receipt details
                    <kbd className="ml-auto text-[10px] px-1 py-0.5 bg-muted rounded">D</kbd>
                  </DropdownMenuItem>
                  {onEmail && (
                    <DropdownMenuItem onClick={onEmail}>
                      <Mail className="h-4 w-4 mr-2" />
                      Email receipt
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={handleSavePdf} disabled={isSavingPdf}>
                    <FileDown className="h-4 w-4 mr-2" />
                    {isSavingPdf ? "Saving…" : "Save PDF"}
                  </DropdownMenuItem>
                  {hasReceiptPrinterRegistered && !thermalAvailable && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={renderAndShowPdf}>
                        <FileDown className="h-4 w-4 mr-2" />
                        Print PDF instead
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </Card>
        </div>
      </div>

      {/* Side sheet — receipt preview opens on demand, never crowds the
          confirmation card. */}
      <Sheet open={showDetails} onOpenChange={setShowDetails}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Receipt details</SheetTitle>
            <SheetDescription>
              {model.meta.transaction_number} ·{" "}
              {format(new Date(model.meta.created_at), "MMM d, h:mm a")}
            </SheetDescription>
          </SheetHeader>
          <Tabs defaultValue="summary" className="mt-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="printer">Printer preview ({paperWidth})</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="mt-4">
              <TransactionSummaryView model={model} />
            </TabsContent>
            <TabsContent value="printer" className="mt-4">
              <div className="flex justify-center">
                {(() => {
                  // Stage X (Wave 2): the operator-facing thermal preview
                  // is now the same monospace grid engine (`buildReceiptLines`
                  // + `MonospacePreview`) that drives the ReceiptPreviewDialog
                  // reprint surface AND the server ESC/POS / thermal PDF
                  // pipelines. No divergent HTML renderer.
                  const rs = { ...liveSettings, paper_size: paperWidth };
                  const built = buildReceiptLines({
                    settings: rs,
                    company: {
                      name: branding?.name || currentOrg?.name || "Store",
                      logo_url: branding?.logo_url ?? null,
                      address: branding?.address ?? null,
                      city: branding?.city ?? null,
                      phone: branding?.phone ?? null,
                      email: branding?.email ?? null,
                      tax_id: null,
                    },
                    transaction: {
                      id: transaction.id,
                      transaction_number: transaction.transaction_number,
                      created_at: transaction.created_at,
                      subtotal: transaction.subtotal,
                      tax_amount: transaction.tax_amount,
                      discount_amount: transaction.discount_amount,
                      total_amount: transaction.total_amount,
                      customer_name: transaction.customer_name,
                      cashier_name: transaction.cashier_name,
                      register_id: transaction.register_id,
                      items: transaction.items.map((it) => ({
                        product_name: it.product_name,
                        sku: it.sku,
                        quantity: it.quantity,
                        unit_price: it.unit_price,
                        discount_amount: it.discount_amount,
                        line_total: it.line_total,
                      })),
                      payments: transaction.payments,
                      etims_cu_number: transaction.etims_cu_number,
                      etims_qr_data: transaction.etims_qr_data,
                    },
                  });
                  return (
                    <MonospacePreview
                      lines={built.lines}
                      meta={built.meta}
                      columns={built.columns}
                      marginCols={built.marginCols}
                      paper={built.paper}
                    />
                  );
                })()}
              </div>
            </TabsContent>
          </Tabs>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={handlePrint} disabled={isPrinting}>
              {isPrinting ? (
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
              ) : (
                <Printer className="h-3.5 w-3.5 mr-2" />
              )}
              {showReprint ? "Reprint" : "Print"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleSavePdf} disabled={isSavingPdf}>
              <FileDown className="h-3.5 w-3.5 mr-2" />
              Save PDF
            </Button>
            {onEmail && (
              <Button variant="outline" size="sm" onClick={onEmail} className="col-span-2">
                <Mail className="h-3.5 w-3.5 mr-2" />
                Email receipt
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PrintStatusPill({
  state,
  channelLabel,
}: {
  state: PrintState;
  channelLabel: string | null;
}) {
  if (state.kind === "idle") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground rounded-full bg-muted/60 px-2 py-1">
        <Printer className="h-3 w-3" />
        Ready
      </span>
    );
  }
  if (state.kind === "printing") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Printing…
      </span>
    );
  }
  if (state.kind === "printed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] rounded-full bg-green-500/10 text-green-700 dark:text-green-400 px-2 py-1">
        <Check className="h-3 w-3" />
        {channelLabel}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] rounded-full bg-destructive/10 text-destructive px-2 py-1 max-w-[220px]"
      title={state.message}
    >
      <AlertTriangle className="h-3 w-3" />
      <span className="truncate">Print failed</span>
    </span>
  );
}
