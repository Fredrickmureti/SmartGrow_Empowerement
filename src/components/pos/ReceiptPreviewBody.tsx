/**
 * ReceiptPreviewBody — shell-agnostic body for the pro-forma / reprint
 * receipt preview. Consumed by two shells:
 *
 *   - `ReceiptPreviewDialog` — legacy Radix Dialog wrapper still used by
 *     `POSReports` (admin reprint from a report row).
 *   - `ReceiptPreviewSheet`  — SheetShell-hosted variant mounted inside
 *     the sale workspace for the restaurant "Print Bill" (pro-forma)
 *     flow, per the workstation-states rule that in-terminal popups
 *     must be sheets, not page dialogs.
 *
 * The body owns:
 *   - snapshot resolution (`useReceiptSnapshot`)
 *   - hardware-vs-PDF print decisioning (ADR-0008 unified pipeline)
 *   - fallback dialog + send-invoice dialog nested modals
 *   - the two-tab summary/printer preview layout
 *
 * It does NOT own outer chrome (title, width, close button) — the
 * hosting shell renders that. `onClose` is invoked when a body action
 * requests dismissal (Done, Clone).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Printer, Mail, Loader2, FileDown, AlertTriangle, Wifi, FileText } from "lucide-react";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDocumentBranding } from "@/hooks/useDocumentBranding";
import { useMergedReceiptSettings } from "@/hooks/pos/useMergedReceiptSettings";
import { useReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";
import { mergeReceiptSettings } from "@/lib/pos/mergeReceiptSettings";
import { useToast } from "@/hooks/use-toast";
import { PrintFallbackDialog } from "./PrintFallbackDialog";
import { buildReceiptLines } from "@/lib/receipt/preview/buildReceiptLines";
import { MonospacePreview } from "@/lib/receipt/preview/MonospacePreview";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TransactionSummaryView } from "@/components/pos/TransactionSummaryView";
import { buildReceiptDocument } from "@/lib/pos/receipt/ReceiptDocumentModel";
import { useHardwareProxy } from "@/hooks/hardware/useHardwareProxy";
import { useIntentReadiness } from "@/hooks/hardware/useIntentReadiness";
import { printDocument } from "@/services/printing/PrintService";
import type { ReceiptCompanyData } from "@/types/receipt";
import type { PrintFallbackAction } from "@/services/printing/types";
import { normalizeError } from "@/services/resilience";

export interface ReceiptPreviewTransaction {
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
}

export interface ReceiptPreviewBodyProps {
  transaction: ReceiptPreviewTransaction;
  onClose: () => void;
  onPrint?: () => void;
  onEmail?: () => void;
  /**
   * When supplied, a "Clone" button appears so the caller can re-open a
   * POS session pre-filled with the same line items (Enerpize-style).
   */
  onClone?: () => void;
}

/**
 * Snapshot-typed shape for the nested `business` / `branch` blobs. The
 * snapshot payload is `unknown` at the type-system boundary; narrowing to
 * this local view keeps the rest of the body strictly typed.
 */
interface SnapshotBusinessLike {
  name?: string | null;
  logo_url?: string | null;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  tax_id?: string | null;
}
interface SnapshotBranchLike {
  address?: string | null;
  city?: string | null;
  phone?: string | null;
}

export function ReceiptPreviewBody({
  transaction,
  onClose,
  onPrint,
  onEmail,
  onClone,
}: ReceiptPreviewBodyProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  // POS receipts ALWAYS issue from a specific branch (the till's branch).
  const { branding } = useDocumentBranding(currentBusiness?.id ?? null, currentBranch?.id ?? null);

  const { mergedSettings: liveReceiptSettings } = useMergedReceiptSettings();
  // Stage B: prefer the frozen snapshot for branding + receipt settings so a
  // reprint never silently re-renders against current product/template state.
  const { data: snapshot, isLoading: isLoadingSnapshot, isFetched: snapshotFetched } = useReceiptSnapshot(transaction.id);
  const { toast } = useToast();
  const [isPrinting, setIsPrinting] = useState(false);
  const [showFallbackDialog, setShowFallbackDialog] = useState(false);
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [showInvoiceEmail, setShowInvoiceEmail] = useState(false);
  // Phase 3 — opt-in: when toggled, the reprint asks the server to rebuild
  // receipt settings (paper width, columns, formatting) from the current
  // editor instead of the frozen-at-sale snapshot. The transaction identity
  // (line items, totals, eTIMS, branding) stays frozen.
  const [useCurrentSettings, setUseCurrentSettings] = useState(false);

  // Hardware actions still come from the proxy, but READINESS comes from the
  // single readiness service — a relay-routed printer owned by another
  // machine's agent is reachable even though it is not "connected" locally.
  useHardwareProxy(transaction.register_id, { passive: true });
  const receiptReadiness = useIntentReadiness("receipt", {
    scope: transaction.register_id
      ? { kind: "register", id: transaction.register_id }
      : undefined,
  });

  const isNetworkPrinterConnected = receiptReadiness.isReady;

  // First-paint guard: while the frozen snapshot is still loading and we
  // haven't tried fetching it yet, render a lightweight skeleton instead of
  // the live-data fallback. Without this the surface briefly paints a
  // "generic" version (single-line items, no branding) and then re-paints
  // with the configured tabular/branded layout once the snapshot arrives.
  if (isLoadingSnapshot && !snapshotFetched && !snapshot) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">Preparing receipt…</p>
      </div>
    );
  }

  const snapBusiness = snapshot?.business as SnapshotBusinessLike | undefined;
  const snapBranch = snapshot?.branch as SnapshotBranchLike | undefined;
  // Phase 3 — when "Use current settings" is on, the on-screen preview is
  // built from the live editor pair so the operator sees the layout the
  // server will actually emit. Otherwise prefer the frozen snapshot pair.
  const receiptSettings = (snapshot && !useCurrentSettings)
    ? mergeReceiptSettings(
        // Snapshot columns are Json in the DB and typed `unknown` here;
        // the merge helper validates at runtime so an `unknown` cast is
        // safe and preferable to `any` inside strict-lint scopes.
        snapshot.business_receipt_settings as unknown as Parameters<typeof mergeReceiptSettings>[0],
        snapshot.register_receipt_settings as unknown as Parameters<typeof mergeReceiptSettings>[1],
      )
    : liveReceiptSettings;

  // Company data retained for downstream consumers (email dialog) and the
  // on-screen visual preview. Canonical render bytes (PDF + ESC/POS) are
  // produced server-side by `generate-document`.
  const companyData: ReceiptCompanyData = {
    name: snapBusiness?.name || branding?.name || currentOrg?.name || "Store",
    logo_url: snapBusiness?.logo_url ?? branding?.logo_url ?? null,
    address: snapBranch?.address ?? snapBusiness?.address ?? branding?.address ?? null,
    city: snapBranch?.city ?? snapBusiness?.city ?? branding?.city ?? null,
    phone: snapBranch?.phone ?? snapBusiness?.phone ?? branding?.phone ?? null,
    email: snapBusiness?.email ?? branding?.email ?? null,
    tax_id: snapBusiness?.tax_id ?? null,
  };
  void companyData;

  // One pipeline (ADR-0008 / enterprise printing consolidation). This
  // surface states the business intent — "print this receipt" — and
  // PrintService owns policy, the ledger row, rendering, device
  // resolution and dispatch. The receipt therefore prints exactly the
  // way a shelf label or an invoice does: no local thermal-vs-PDF fork,
  // no direct hardware call, no second byte source.
  const handlePrint = async () => {
    setIsPrinting(true);
    try {
      const result = await printDocument({
        documentType: "pos_receipt",
        documentId: transaction.id,
        forceRefreshSettings: useCurrentSettings,
      });
      if (result.success) {
        toast({
          title: "Receipt printed",
          description: result.transport === "thermal" ? "Sent to receipt printer" : "Sent to printer",
        });
        onPrint?.();
      } else {
        // Never fail silently — the operator chooses PDF / email / retry.
        setShowFallbackDialog(true);
      }
    } catch (error) {
      console.error("[ReceiptPreviewBody] Print error:", error);
      toast({
        title: "Print failed",
        description: error instanceof Error ? normalizeError(error).message : "Unknown error",
        variant: "destructive",
      });
    }
    setIsPrinting(false);
  };

  const saveReceiptPdf = async (): Promise<boolean> => {
    const result = await printDocument({
      documentType: "pos_receipt",
      documentId: transaction.id,
      medium: "pdf",
      disposition: "download",
      filename: `receipt-${transaction.transaction_number}`,
      forceRefreshSettings: useCurrentSettings,
    });
    if (!result.success) throw new Error(result.error ?? "Could not generate receipt PDF");
    return true;
  };

  // Fallback dialog action handler. Legacy HTML download path removed —
  // the server engine is the only byte source.
  const handleFallbackAction = async (action: PrintFallbackAction) => {
    const resolver = (window as unknown as { __printFallbackResolver?: (a: PrintFallbackAction) => void })
      .__printFallbackResolver;

    if (action === "pdf") {
      setIsSavingPdf(true);
      try {
        await saveReceiptPdf();
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
    } else if (action === "email") {
      setShowFallbackDialog(false);
      onEmail?.();
    } else if (action === "preview") {
      setShowFallbackDialog(false);
    } else if (action === "retry") {
      setShowFallbackDialog(false);
      await handlePrint();
    } else {
      setShowFallbackDialog(false);
    }

    if (resolver) {
      resolver(action);
      delete (window as unknown as { __printFallbackResolver?: unknown }).__printFallbackResolver;
    }
  };

  // Direct "Save PDF" button — same pipeline, download disposition.
  const handleSavePdf = async () => {
    setIsSavingPdf(true);
    try {
      await saveReceiptPdf();
      toast({ title: "Receipt saved", description: "PDF downloaded successfully" });
    } catch (error) {
      console.error("[ReceiptPreviewBody] Save PDF failed:", error);
      toast({
        title: "Save failed",
        description: error instanceof Error ? normalizeError(error).message : "Could not save receipt",
        variant: "destructive",
      });
    } finally {
      setIsSavingPdf(false);
    }
  };


  const hasAnyPrinter = receiptReadiness.isReady;

  return (
    <div className="flex flex-col gap-3">
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
      {receiptReadiness.isReady && (
        <div className="flex items-center gap-2 p-2 rounded-md bg-green-500/10 text-green-600 text-xs">
          <Wifi className="h-4 w-4 shrink-0" />
          <span>{receiptReadiness.message}</span>
        </div>
      )}

      {/* Printer Status Warning */}
      {!hasAnyPrinter && (
        <div className="flex items-center gap-2 p-2 rounded-md bg-amber-500/10 text-amber-600 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {receiptReadiness.message}. You can save as PDF or email instead.
          </span>
        </div>
      )}

      {/* Phase 3 — opt-in: rebuild receipt rendering settings from the
          current editor on reprint. The transaction itself stays frozen
          for fiscal audit integrity. */}
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
          {hasAnyPrinter ? "Print" : "Print..."}
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
        {onClone && (
          <Button
            variant="secondary"
            className="flex-1 h-10 sm:h-9 text-sm"
            onClick={() => {
              onClone();
              onClose();
            }}
          >
            Clone
          </Button>
        )}
        <Button className="flex-1 h-10 sm:h-9 text-sm" onClick={onClose}>
          Done
        </Button>
      </div>

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
    </div>
  );
}
