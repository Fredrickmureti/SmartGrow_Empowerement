import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Printer, Mail, Check, Loader2, FileDown, AlertTriangle, Wifi, FileText } from "lucide-react";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDocumentBranding } from "@/hooks/useDocumentBranding";
import { useMergedReceiptSettings } from "@/hooks/pos/useMergedReceiptSettings";
import { useReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";
import { mergeReceiptSettings } from "@/lib/pos/mergeReceiptSettings";
import { hardwareClient } from "@/services/hardware/HardwareClient";
import { useToast } from "@/hooks/use-toast";
import { PrintFallbackDialog } from "./PrintFallbackDialog";
import { buildReceiptLines } from "@/lib/receipt/preview/buildReceiptLines";
import { MonospacePreview } from "@/lib/receipt/preview/MonospacePreview";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TransactionSummaryView } from "@/components/pos/TransactionSummaryView";
import { buildReceiptDocument } from "@/lib/pos/receipt/ReceiptDocumentModel";
import { useHardwareProxy } from "@/hooks/hardware/useHardwareProxy";
import {
  generateDocumentEscPosBytes,
  generateDocumentPdf,
  printPdfInPage,
  downloadPdfBlob,
} from "@/services/printing/pdfUtils";
import type { ReceiptCompanyData } from "@/types/receipt";
import type { PrintFallbackAction } from "@/services/printing/types";
import { normalizeError } from "@/services/resilience";

interface ReceiptPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: {
    id: string;
    transaction_number: string;
    total_amount: number;
    subtotal: number;
    tax_amount: number;
    discount_amount: number;
    created_at: string;
    payment_method?: string;
    customer_name?: string;
    cashier_name?: string;
    register_id?: string;
    invoice_id?: string | null;
    invoice_number?: string | null;
    etims_cu_number?: string | null;
    etims_qr_data?: string | null;
    items: Array<{
      product_name: string;
      sku?: string;
      quantity: number;
      unit_price: number;
      discount_amount?: number;
      line_total: number;
    }>;
    payments: Array<{
      payment_method: string;
      amount: number;
      reference?: string;
    }>;
    is_voided?: boolean;
    is_refund?: boolean;
    original_transaction_number?: string | null;
  } | null;
  onPrint?: () => void;
  onEmail?: () => void;
}

export function ReceiptPreviewDialog({
  open,
  onOpenChange,
  transaction,
  onPrint,
  onEmail,
}: ReceiptPreviewDialogProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  // POS receipts ALWAYS issue from a specific branch (the till's branch).
  // Pass branch context so receipt prefix / logo / contact overrides apply.
  const { branding } = useDocumentBranding(currentBusiness?.id ?? null, currentBranch?.id ?? null);
  
  const { mergedSettings: liveReceiptSettings } = useMergedReceiptSettings();
  // Stage B: prefer the frozen snapshot for branding + receipt settings so a
  // reprint never silently re-renders against current product/template state.
  const { data: snapshot, isLoading: isLoadingSnapshot, isFetched: snapshotFetched } = useReceiptSnapshot(transaction?.id);
  const { toast } = useToast();
  const [isPrinting, setIsPrinting] = useState(false);
  const [showFallbackDialog, setShowFallbackDialog] = useState(false);
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [showInvoiceEmail, setShowInvoiceEmail] = useState(false);
  // Phase 3 — opt-in: when toggled, the Reprint dialog asks the server to
  // rebuild receipt settings (paper width, columns, formatting) from the
  // current editor instead of the frozen-at-sale snapshot. The transaction
  // identity (line items, totals, eTIMS, branding) stays frozen.
  const [useCurrentSettings, setUseCurrentSettings] = useState(false);
  
  // Unified hardware proxy (System A) — single source of truth
  const { printerStatus: getProxyPrinterStatus, isRoleAvailable, printRawBytes } = useHardwareProxy(transaction?.register_id);
  const proxyPrinterStatus = getProxyPrinterStatus();
  const isPrinterConnectedViaProxy = proxyPrinterStatus === 'connected';

  const isNetworkPrinterConnected = isPrinterConnectedViaProxy;
  const networkConfig = null;

  if (!transaction) return null;

  // First-paint guard: while the frozen snapshot is still loading and we
  // haven't tried fetching it yet, render a small skeleton instead of the
  // live-data fallback. Without this the dialog briefly paints a "generic"
  // version (single-line items, no branding) and then re-paints with the
  // configured tabular/branded layout once the snapshot arrives — the
  // "two modals" effect operators were seeing.
  if (isLoadingSnapshot && !snapshotFetched && !snapshot) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[95vw] sm:max-w-md lg:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Check className="h-4 w-4 sm:h-5 sm:w-5 text-green-600 shrink-0" />
              <span className="truncate">Transaction Complete</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Preparing receipt…</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }


  const snapBusiness = snapshot?.business as any | undefined;
  const snapBranch = snapshot?.branch as any | undefined;
  // Phase 3 — when "Use current settings" is on, the on-screen preview is
  // built from the live editor pair so the operator sees the layout the
  // server will actually emit. Otherwise prefer the frozen snapshot pair.
  const receiptSettings = (snapshot && !useCurrentSettings)
    ? mergeReceiptSettings(
        snapshot.business_receipt_settings as any,
        snapshot.register_receipt_settings as any,
      )
    : liveReceiptSettings;

  // Company data is only retained for downstream consumers (e.g. email
  // dialog) and the on-screen visual preview. The canonical render bytes
  // (PDF + ESC/POS) are produced server-side by `generate-document`.
  const companyData: ReceiptCompanyData = {
    name: snapBusiness?.name || branding?.name || currentOrg?.name || 'Store',
    logo_url: snapBusiness?.logo_url ?? branding?.logo_url ?? null,
    address: snapBranch?.address ?? snapBusiness?.address ?? branding?.address ?? null,
    city: snapBranch?.city ?? snapBusiness?.city ?? branding?.city ?? null,
    phone: snapBranch?.phone ?? snapBusiness?.phone ?? branding?.phone ?? null,
    email: snapBusiness?.email ?? branding?.email ?? null,
    tax_id: snapBusiness?.tax_id ?? null,
  };
  void companyData;

  // W4b (ADR-0008): single rendering pipeline. Thermal hardware → fetch
  // ESC/POS bytes from `generate-document` and stream via the hardware
  // proxy. No fallback to a client-side byte builder — that path was
  // deleted along with `ReceiptEscPosBuilder`.
  const printToHardwarePrinter = async (): Promise<boolean> => {
    try {
      const bytes = await generateDocumentEscPosBytes('pos_receipt', transaction.id, {
        forceRefreshSettings: useCurrentSettings,
      });
      const result = await printRawBytes(bytes);
      return result.success;
    } catch (error) {
      console.error('[ReceiptPreviewDialog] Hardware print failed:', error);
      throw error;
    }
  };

  // W4b: single rendering pipeline. Order of preference:
  //   1) thermal printer reachable  → ESC/POS bytes from generate-document
  //   2) no thermal printer         → server PDF + in-page print
  //   3) PDF generation fails       → show fallback dialog (PDF download / email)
  const handlePrint = async () => {
    setIsPrinting(true);
    try {
      if (isNetworkPrinterConnected) {
        const success = await printToHardwarePrinter();
        if (success) {
          toast({
            title: "Receipt printed",
            description: `Sent to ${networkConfig?.ipAddress ?? 'thermal printer'}`,
          });
          onPrint?.();
        } else {
          toast({
            title: "Print failed",
            description: "Failed to print to thermal printer",
            variant: "destructive",
          });
        }
        setIsPrinting(false);
        return;
      }

      // No thermal printer → server PDF + in-page print.
      try {
        const blob = await generateDocumentPdf('pos_receipt', transaction.id, { forceRefreshSettings: useCurrentSettings });
        await printPdfInPage(blob);
        onPrint?.();
      } catch (err) {
        console.error('[ReceiptPreviewDialog] Unified PDF print failed:', err);
        // Last resort — show the fallback dialog so the operator can
        // download / email instead of failing silently.
        setShowFallbackDialog(true);
      }
    } catch (error) {
      console.error('[ReceiptPreviewDialog] Print error:', error);
      toast({
        title: "Print failed",
        description: error instanceof Error ? normalizeError(error).message : "Unknown error",
        variant: "destructive",
      });
    }
    setIsPrinting(false);
  };

  // Fallback dialog action handler. Legacy HTML download path removed —
  // the server engine is the only byte source.
  const handleFallbackAction = async (action: PrintFallbackAction) => {
    const resolver = (window as any).__printFallbackResolver;

    if (action === 'pdf') {
      setIsSavingPdf(true);
      try {
        const blob = await generateDocumentPdf('pos_receipt', transaction.id, { forceRefreshSettings: useCurrentSettings });
        downloadPdfBlob(blob, `receipt-${transaction.transaction_number}.pdf`);
        toast({ title: "Receipt saved", description: "PDF downloaded successfully" });
        setShowFallbackDialog(false);
      } catch (err) {
        toast({
          title: "Save failed",
          description: err instanceof Error ? normalizeError(err).message : "Could not generate receipt PDF",
          variant: "destructive",
        });
      } finally {
        setIsSavingPdf(false);
      }
    } else if (action === 'email') {
      setShowFallbackDialog(false);
      onEmail?.();
    } else if (action === 'preview') {
      setShowFallbackDialog(false);
    } else if (action === 'retry') {
      // Audit Wave 10 — honest probe via the unified device registry.
      const statuses = await hardwareClient.devices.getStatuses();
      const available = statuses.some((s) => s.role === 'receipt_printer' && s.connected);
      if (available) {
        setShowFallbackDialog(false);
        handlePrint();
      } else {
        toast({
          title: "Still no printer",
          description: "No printer detected. Try connecting a printer.",
          variant: "destructive",
        });
      }
    } else {
      setShowFallbackDialog(false);
    }

    if (resolver) {
      resolver(action);
      delete (window as any).__printFallbackResolver;
    }
  };

  // Direct "Save PDF" button — always uses server-side generation.
  const handleSavePdf = async () => {
    setIsSavingPdf(true);
    try {
      const blob = await generateDocumentPdf('pos_receipt', transaction.id, { forceRefreshSettings: useCurrentSettings });
      downloadPdfBlob(blob, `receipt-${transaction.transaction_number}.pdf`);
      toast({ title: "Receipt saved", description: "PDF downloaded successfully" });
    } catch (error) {
      console.error('[ReceiptPreviewDialog] Save PDF failed:', error);
      toast({
        title: "Save failed",
        description: error instanceof Error ? normalizeError(error).message : "Could not save receipt",
        variant: "destructive",
      });
    } finally {
      setIsSavingPdf(false);
    }
  };

  // Determine if we have any printer available (OS or network or proxy)
  const hasAnyPrinter = isNetworkPrinterConnected || isRoleAvailable('receipt_printer');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl lg:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Check className="h-4 w-4 sm:h-5 sm:w-5 text-green-600 shrink-0" />
            <span className="truncate">Transaction Complete</span>
          </DialogTitle>
        </DialogHeader>

        {/* Tabs: Summary (screen-optimized) | Printer preview (WYSIWYG ESC/POS) */}
        <Tabs defaultValue="summary">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="printer">Printer preview</TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="mt-3">
            {(() => {
              const model = buildReceiptDocument({
                snapshot: snapshot ?? null,
                live: {
                  id: transaction.id,
                  transaction_number: transaction.transaction_number,
                  total_amount: transaction.total_amount,
                  subtotal: transaction.subtotal,
                  tax_amount: transaction.tax_amount,
                  discount_amount: transaction.discount_amount,
                  created_at: transaction.created_at,
                  payment_method: transaction.payment_method,
                  customer_name: transaction.customer_name,
                  cashier_name: transaction.cashier_name,
                  register_id: transaction.register_id,
                  invoice_id: transaction.invoice_id,
                  invoice_number: transaction.invoice_number,
                  etims_cu_number: transaction.etims_cu_number,
                  etims_qr_data: transaction.etims_qr_data,
                  items: transaction.items,
                  payments: transaction.payments,
                  is_voided: transaction.is_voided,
                  is_refund: transaction.is_refund,
                },
                liveSettings: liveReceiptSettings,
                liveBranding: {
                  business_name: branding?.name || currentOrg?.name || "Store",
                  logo_url: branding?.logo_url ?? null,
                  address: branding?.address ?? null,
                  city: branding?.city ?? null,
                  phone: branding?.phone ?? null,
                  email: branding?.email ?? null,
                  tax_id: null,
                },
              });
              return <TransactionSummaryView model={model} />;
            })()}
          </TabsContent>

          <TabsContent value="printer" className="mt-3">
            <div className="relative bg-muted/50 rounded-lg p-3 sm:p-4 flex justify-center">
              {transaction.is_voided && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center justify-center select-none z-10"
                >
                  <span className="text-destructive/30 font-extrabold tracking-widest text-5xl sm:text-6xl rotate-[-25deg] border-4 border-destructive/30 px-6 py-2 rounded">
                    VOID
                  </span>
                </div>
              )}
              {!transaction.is_voided && transaction.is_refund && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center justify-center select-none z-10"
                >
                  <span className="text-amber-500/40 font-extrabold tracking-widest text-5xl sm:text-6xl rotate-[-25deg] border-4 border-amber-500/40 px-6 py-2 rounded">
                    REFUND
                  </span>
                </div>
              )}
              {(() => {
                const built = buildReceiptLines({
                  settings: receiptSettings,
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

        {/* Printer Status Indicator */}
        {isNetworkPrinterConnected && networkConfig && (
          <div className="flex items-center gap-2 p-2 rounded-md bg-green-500/10 text-green-600 text-xs">
            <Wifi className="h-4 w-4 shrink-0" />
            <span>Receipt printer ready ({networkConfig.ipAddress})</span>
          </div>
        )}

        {/* Printer Status Warning */}
        {!hasAnyPrinter && (
          <div className="flex items-center gap-2 p-2 rounded-md bg-amber-500/10 text-amber-600 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>No printer connected. You can save as PDF or email instead.</span>
          </div>
        )}

        {/* Phase 3 — opt-in: rebuild receipt rendering settings (paper width,
            columns, formatting) from the current editor on reprint. The
            transaction itself stays frozen for fiscal audit integrity. */}
        {snapshot && (
          <div className="flex items-center justify-between gap-3 px-1 py-2 border-t">
            <div className="space-y-0.5">
              <Label htmlFor="use-current-settings" className="text-xs sm:text-sm font-medium">
                Use current receipt settings
              </Label>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Re-render with today's editor (paper width, columns) instead of the snapshot.
              </p>
            </div>
            <Switch
              id="use-current-settings"
              checked={useCurrentSettings}
              onCheckedChange={setUseCurrentSettings}
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Button 
            variant={hasAnyPrinter ? "outline" : "secondary"} 
            className="flex-1 h-10 sm:h-9 text-sm" 
            onClick={handlePrint} 
            disabled={isPrinting}
          >
            {isPrinting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : isNetworkPrinterConnected ? (
              <Wifi className="h-4 w-4 mr-2" />
            ) : (
              <Printer className="h-4 w-4 mr-2" />
            )}
            {hasAnyPrinter ? 'Print' : 'Print...'}
          </Button>
          <Button 
            variant="outline" 
            className="flex-1 h-10 sm:h-9 text-sm" 
            onClick={handleSavePdf}
            disabled={isSavingPdf}
          >
            {isSavingPdf ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileDown className="h-4 w-4 mr-2" />}
            Save PDF
          </Button>
          {transaction.invoice_id ? (
            <Button 
              variant="outline" 
              className="flex-1 h-10 sm:h-9 text-sm" 
              onClick={() => setShowInvoiceEmail(true)}
            >
              <FileText className="h-4 w-4 mr-2" />
              Send Invoice
            </Button>
          ) : (
            <Button variant="outline" className="flex-1 h-10 sm:h-9 text-sm" onClick={onEmail}>
              <Mail className="h-4 w-4 mr-2" />
              Email
            </Button>
          )}
          <Button className="flex-1 h-10 sm:h-9 text-sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>

      {/* Fallback Dialog for No Printer */}
      <PrintFallbackDialog
        open={showFallbackDialog}
        onOpenChange={setShowFallbackDialog}
        printerStatus={null}
        onAction={handleFallbackAction}
        isProcessing={isSavingPdf}
        transactionNumber={transaction.transaction_number}
        showEmailOption={!!onEmail}
      />
      {/* Send Invoice Dialog (uses unified Sales module email engine) */}
      {transaction.invoice_id && (
        <SendDocumentDialog
          open={showInvoiceEmail}
          onOpenChange={setShowInvoiceEmail}
          document={{
            documentType: "invoice",
            documentId: transaction.invoice_id,
            documentNumber: transaction.invoice_number || transaction.transaction_number,
            recipientName: transaction.customer_name,
            total: transaction.total_amount,
          }}
        />
      )}
    </Dialog>
  );
}
