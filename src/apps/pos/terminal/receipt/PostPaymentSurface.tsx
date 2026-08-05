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
import type { LineMeta } from "@/lib/receipt/preview/buildReceiptLines";
import { MonospacePreview } from "@/lib/receipt/preview/MonospacePreview";
import { printDocument, startPrintDocument, renderDocumentBlob, renderDocumentPreview } from "@/services/printing/PrintService";
import { usePrintJobStatus } from "@/hooks/printing/usePrintJobStatus";
import { downloadPdfBlob, printPdfInPage } from "@/services/printing/pdfUtils";
import { TransactionSummaryView } from "@/components/pos/TransactionSummaryView";

export type PrintPolicyHint = {
  auto_print: boolean;
  render_mode: "pdf" | "escpos";
  paper_format: "58mm" | "80mm" | "40mm" | "a4" | "a5" | "letter" | "custom";
};

interface PostPaymentSurfaceProps {
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
  /** Ledger row exists; bytes are being rendered/dispatched in the background. */
  | { kind: "queued" }
  | { kind: "printing" }
  | { kind: "printed"; channel: "thermal" | "pdf" }
  | { kind: "failed"; message: string };

export function PostPaymentSurface({
  transaction,
  open,
  onNewSale,
  onEmail,
  policy,
  isReprint = false,
}: PostPaymentSurfaceProps) {
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
    updateDisplay,
    reconnectRole,
    deviceStatuses,
    agentAvailable,
    devices,
  } = useHardwareProxy(transaction?.register_id ?? undefined, {
    passive: isReprint,
  });

  const [printState, setPrintState] = useState<PrintState>({ kind: "idle" });
  // Phase 2: the thermal path no longer blocks the cashier, so the outcome
  // arrives from the `print_jobs` ledger rather than from an awaited call.
  const [printJobIds, setPrintJobIds] = useState<string[]>([]);
  const jobStatus = usePrintJobStatus(printJobIds);
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  // Wave 12 redesign — the receipt preview is a first-class column on this
  // screen (right side). The old "details" drawer is gone. `showPreview`
  // now just toggles between the on-screen SALE SUMMARY and the paper
  // WYSIWYG preview inside that right column.
  const [showPreview, setShowPreview] = useState<"summary" | "paper">(
    isReprint ? "paper" : "summary",
  );
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
      const blob = await renderDocumentBlob("pos_receipt", model.meta.transaction_id);
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
        // One pipeline, two moments. `startPrintDocument` resolves as soon
        // as the durable `print_jobs` rows exist — the sweeper can recover
        // the print from there even if this tab closes — and renders +
        // dispatches in the background. The cashier is released here; the
        // ledger drives the status pill from now on.
        const ack = await startPrintDocument({
          documentType: "pos_receipt",
          documentId: model.meta.transaction_id,
          intent: "receipt",
          medium: "escpos",
          organizationId: currentOrg?.id ?? null,
          businessId: currentBusiness?.id ?? null,
          branchId: currentBranch?.id ?? null,
        });
        if (!ack.queued) {
          const errMsg = ack.error || "Could not queue the receipt";
          setPrintState({ kind: "failed", message: errMsg });
          toast({
            title: "Receipt printer failed",
            description: errMsg,
            variant: "destructive",
          });
          return;
        }
        setPrintJobIds(ack.jobIds);
        setPrintState({ kind: "queued" });
        // No ledger rows (platform-admin / no business context) means there
        // is nothing to follow — fall back to the completion promise.
        void ack.completion.then((res) => {
          if (ack.jobIds.length > 0) return;
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
        });
        return;
      }
      // No thermal printer at all → server PDF in-page.
      const blob = await renderDocumentBlob("pos_receipt", model.meta.transaction_id);
      await printPdfInPage(blob);
      setPrintState({ kind: "printed", channel: "pdf" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Print failed";
      setPrintState({ kind: "failed", message });
      toast({ title: "Print failed", description: message, variant: "destructive" });
    }
  }, [model, thermalAvailable, currentOrg?.id, currentBusiness?.id, currentBranch?.id, toast]);

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
      const blob = await renderDocumentBlob("pos_receipt", model.meta.transaction_id);
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

  // Ledger → UI. `queued`/`sent` keep the pill spinning, `acked` closes it.
  useEffect(() => {
    if (printJobIds.length === 0) return;
    if (jobStatus.phase === "printed") {
      setPrintState({ kind: "printed", channel: "thermal" });
    } else if (jobStatus.phase === "failed") {
      const message = jobStatus.error || "Receipt printer failed";
      setPrintState({ kind: "failed", message });
      toast({
        title: "Receipt printer failed",
        description: message,
        variant: "destructive",
      });
    } else if (jobStatus.phase === "sent") {
      setPrintState({ kind: "printing" });
    }
  }, [jobStatus.phase, jobStatus.error, printJobIds.length, toast]);

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
      setShowPreview((v) => (v === "summary" ? "paper" : "summary"));
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
  const isPrinting = printState.kind === "printing" || printState.kind === "queued";

  return (
    <div
      aria-label="Transaction complete"
      data-testid="post-payment-screen"
      className="absolute inset-0 z-40 flex flex-col bg-background text-foreground"
    >
      {/* ─── Top status bar ─────────────────────────────────────────────
          A single, dense strip: brand mark, transaction identity, print
          status, receipt-view toggle. Everything the cashier's eye needs
          to confirm "the right sale just closed" without moving focus. */}
      <header className="flex items-center gap-4 border-b border-border/70 bg-card px-6 py-3 shrink-0">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
          <Check className="h-6 w-6" aria-hidden strokeWidth={2.5} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-semibold tracking-tight">Payment received</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {format(new Date(model.meta.created_at), "MMM d, h:mm a")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {model.meta.title} · <span className="tabular-nums">{model.meta.transaction_number}</span>
            {model.meta.cashier_name ? <> · {model.meta.cashier_name}</> : null}
          </p>
        </div>

        <div className="hidden md:inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setShowPreview("summary")}
            className={`px-3 py-1.5 rounded-sm font-medium transition-colors ${
              showPreview === "summary"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Sale summary
          </button>
          <button
            type="button"
            onClick={() => setShowPreview("paper")}
            className={`px-3 py-1.5 rounded-sm font-medium transition-colors ${
              showPreview === "paper"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Receipt ({paperWidth})
          </button>
        </div>

        <PrintStatusPill state={printState} channelLabel={channelLabel} />
      </header>

      {/* ─── Main body: two columns on desktop, stacked on tablet ────── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto grid h-full max-w-[1600px] grid-cols-1 gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] lg:gap-8 lg:p-8">
          {/* LEFT column — money-first hero + sale detail */}
          <section className="flex flex-col gap-6 min-w-0">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Total paid — the anchor number */}
              <div className="rounded-lg border border-border bg-card p-6">
                <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  Total paid
                </div>
                <div className="mt-2 text-5xl font-semibold tabular-nums leading-none tracking-tight">
                  {formatCurrency(model.totals.total_amount)}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {model.payments.map((p, i) => (
                    <Badge key={i} variant="secondary" className="capitalize font-medium">
                      {p.payment_method.toLowerCase().includes("mpesa")
                        ? "M-Pesa"
                        : p.payment_method}
                      {" · "}
                      <span className="tabular-nums">{formatCurrency(p.amount)}</span>
                    </Badge>
                  ))}
                  {model.flags.is_offline && (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-600">
                      <WifiOff className="mr-1 h-3 w-3" /> Offline
                    </Badge>
                  )}
                </div>
              </div>

              {/* Change due — the second number cashier & customer both look for */}
              {model.totals.change_due > 0 ? (
                <div className="rounded-lg border-2 border-emerald-500/50 bg-emerald-500/[0.06] p-6">
                  <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-400">
                    Change due
                  </div>
                  <div className="mt-2 text-5xl font-semibold tabular-nums leading-none tracking-tight text-emerald-700 dark:text-emerald-400">
                    {formatCurrency(model.totals.change_due)}
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    Tendered{" "}
                    <span className="tabular-nums font-medium text-foreground">
                      {formatCurrency(model.totals.amount_tendered)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-card p-6">
                  <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Tendered
                  </div>
                  <div className="mt-2 text-4xl font-semibold tabular-nums leading-none tracking-tight">
                    {formatCurrency(model.totals.amount_tendered)}
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    {model.items.length} item{model.items.length === 1 ? "" : "s"}
                  </div>
                </div>
              )}
            </div>

            {/* Printer offline banner */}
            {hasReceiptPrinterRegistered && !thermalAvailable && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                <WifiOff className="h-4 w-4 shrink-0" />
                <span className="flex-1 min-w-0">
                  Receipt printer offline — {printerOfflineReason ?? "not responding"}.
                </span>
                <Button size="sm" variant="outline" onClick={handleReconnectPrinter}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reconnect
                </Button>
              </div>
            )}

            {/* Mobile toggle — the desktop segmented control moves here on
                narrow screens so tablet operators can still switch view. */}
            <div className="md:hidden inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs w-fit">
              <button
                type="button"
                onClick={() => setShowPreview("summary")}
                className={`px-3 py-1.5 rounded-sm font-medium ${
                  showPreview === "summary" ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                Sale summary
              </button>
              <button
                type="button"
                onClick={() => setShowPreview("paper")}
                className={`px-3 py-1.5 rounded-sm font-medium ${
                  showPreview === "paper" ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                Receipt
              </button>
            </div>

            {/* On mobile/tablet we swap views; on desktop the summary is
                always visible on the left AND the paper preview on the
                right, so we hide the swap here. */}
            <div className={showPreview === "summary" ? "block" : "hidden lg:block"}>
              <TransactionSummaryView model={model} />
            </div>

            <div className={showPreview === "paper" ? "block lg:hidden" : "hidden"}>
              <ServerReceiptPreview
                paperWidth={paperWidth}
                transactionId={transaction.id}
              />
            </div>
          </section>

          {/* RIGHT column — thermal receipt WYSIWYG, always visible on desktop */}
          <aside className="hidden lg:flex flex-col gap-3 min-w-0">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Receipt preview
              </h3>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {paperWidth} · thermal
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border bg-muted/30 p-6">
              <div className="flex justify-center">
                <ServerReceiptPreview
                  paperWidth={paperWidth}
                  transactionId={transaction.id}
                />
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* ─── Sticky action bar — the fastest surface on the screen ───── */}
      <footer className="border-t border-border bg-card px-4 py-3 shrink-0 sm:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
          {/* Secondary actions on the left — never compete with New sale */}
          <Button
            size="lg"
            variant="outline"
            className="h-14 min-w-[9rem] text-base"
            onClick={handlePrint}
            disabled={isPrinting}
          >
            {isPrinting ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : showRetry ? (
              <RefreshCw className="mr-2 h-5 w-5" />
            ) : showReprint ? (
              <RefreshCw className="mr-2 h-5 w-5" />
            ) : (
              <Printer className="mr-2 h-5 w-5" />
            )}
            {showRetry ? "Retry print" : showReprint ? "Reprint" : "Print"}
            <kbd className="ml-2 hidden rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
              P
            </kbd>
          </Button>

          <Button
            size="lg"
            variant="outline"
            className="h-14 min-w-[9rem] text-base"
            onClick={handleSavePdf}
            disabled={isSavingPdf}
          >
            {isSavingPdf ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <FileDown className="mr-2 h-5 w-5" />
            )}
            Save PDF
          </Button>

          {onEmail && (
            <Button
              size="lg"
              variant="outline"
              className="h-14 min-w-[9rem] text-base"
              onClick={onEmail}
            >
              <Mail className="mr-2 h-5 w-5" />
              Email
            </Button>
          )}

          {/* Overflow — rare actions only */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="lg" variant="outline" className="h-14 w-14 p-0" aria-label="More actions">
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {hasReceiptPrinterRegistered && !thermalAvailable && (
                <>
                  <DropdownMenuItem onClick={renderAndShowPdf}>
                    <FileDown className="mr-2 h-4 w-4" />
                    Print PDF instead
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={handleReconnectPrinter}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Reconnect printer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Primary — New sale — pushed hard right, oversized, autofocus */}
          <div className="ml-auto flex items-center gap-3">
            <Button
              autoFocus
              size="lg"
              className="h-14 min-w-[16rem] text-lg font-semibold"
              onClick={onNewSale}
            >
              <X className="mr-2 h-5 w-5" />
              New sale
              <kbd className="ml-3 hidden rounded bg-background/20 px-2 py-0.5 text-xs sm:inline">
                Enter
              </kbd>
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * ServerReceiptPreview — displays the canonical rows returned alongside the
 * exact ESC/POS artifact. It deliberately does not rebuild a receipt from
 * live transaction/settings state: preview and physical print resolve the
 * same frozen document record through `render-document`.
 */
function ServerReceiptPreview({
  paperWidth,
  transactionId,
}: {
  paperWidth: ReceiptPaperWidth;
  transactionId: string;
}) {
  const [preview, setPreview] = useState<{
    lines: string[];
    meta: LineMeta[];
    columns: number;
    marginCols: number;
    paper: ReceiptPaperWidth;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    void renderDocumentPreview({
      documentType: "pos_receipt",
      documentId: transactionId,
      medium: "escpos",
      paperFormat: paperWidth,
    }).then((artifact) => {
      if (!active) return;
      const metadata = artifact.metadata ?? {};
      const lines = metadata.preview_lines;
      const meta = metadata.preview_line_meta;
      const columns = metadata.resolved_columns;
      const marginCols = metadata.resolved_margin_columns;
      const paper = metadata.resolved_paper;
      if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
        throw new Error("Receipt renderer did not return preview rows");
      }
      if (!Array.isArray(meta) || typeof columns !== "number") {
        throw new Error("Receipt renderer returned incomplete preview metadata");
      }
      setPreview({
        lines,
        meta: meta as LineMeta[],
        columns,
        marginCols: typeof marginCols === "number" ? marginCols : 0,
        paper: paper === "40mm" || paper === "58mm" || paper === "80mm" ? paper : paperWidth,
      });
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "Receipt preview failed");
    });
    return () => { active = false; };
  }, [paperWidth, transactionId]);

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>;
  }
  if (!preview) {
    return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Generating receipt preview" />;
  }
  return (
    <MonospacePreview
      lines={preview.lines}
      meta={preview.meta}
      columns={preview.columns}
      marginCols={preview.marginCols}
      paper={preview.paper}
    />
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
  if (state.kind === "queued") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Queued
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
