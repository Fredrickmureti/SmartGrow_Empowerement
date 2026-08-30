import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Printer, Download, Loader2, ZoomIn, ZoomOut, AlertCircle } from "lucide-react";
// M4: no managed printer estate — output goes to the host print dialog.
import { useToast } from "@/hooks/use-toast";

import { printPdfInPage, downloadPdfBlob } from "@/services/printing/pdfUtils";
import { openInteractiveJob, renderDocumentPreview } from "@/services/printing/PrintService";
import { isElectron as runtimeIsElectron, openPdfPreview } from "@/services/printing/previewSurface";
import { SafePdfViewer } from "@/components/common/SafePdfViewer";
import { SafeHtmlPreview } from "@/components/common/SafeHtmlPreview";
import { useBranch } from "@/contexts/BranchContext";
import { useBusinesses } from "@/contexts/BusinessContext";

import {
  DocumentCommunicationBar,
  type DocumentCommunicationContext,
} from "@/components/communications/DocumentCommunicationBar";
import { DocumentCommunicationHistory } from "@/components/communications/DocumentCommunicationHistory";
import {
  PrintSettingsPopover,
  type PrintSettings,
} from "@/components/common/PrintSettingsPopover";
import { normalizeError } from "@/services/resilience";

interface PrintPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  filename?: string;
  /** Document type for server-side PDF generation */
  documentType?: string;
  /** Document ID for server-side PDF generation */
  documentId?: string;
  /** Legacy: raw HTML for preview (used when documentType/documentId not provided) */
  html?: string;
  isLoading?: boolean;
  /**
   * Optional communication context. When provided, the preview shows
   * Email/SMS actions wired to the shared communication layer so users
   * don't have to close the preview to reach `Send via SMS`.
   */
  communication?: DocumentCommunicationContext;
}

export function PrintPreviewDialog({
  open,
  onOpenChange,
  title,
  filename = "document",
  documentType,
  documentId,
  html,
  isLoading: externalLoading = false,
  communication,
}: PrintPreviewDialogProps) {
  const { toast } = useToast();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Wave B3 (Plan P1) — `pendingPrints` replaces the legacy `isPrinting`
  // boolean. Each Print click enqueues a job on `printPdfInPage`'s FIFO
  // queue (module-scoped in `pdfUtils.ts`) and increments this counter;
  // the counter decrements when that specific job resolves. Rapid clicks
  // no longer no-op — they queue behind the in-flight dialog and print
  // in order, matching the label-path FIFO guarantees.
  const [pendingPrints, setPendingPrints] = useState(0);
  const isPrinting = pendingPrints > 0;
  const [isSavingPDF, setIsSavingPDF] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<string>("__browser__");
  // Microfinance convergence (M4): this institution has no managed
  // printer estate. The only destination is the host print dialog, so the
  // destination list is a constant and raw-byte streaming is unavailable.
  const destinations = useMemo<
    { id: string; label: string; kind: string; connected: boolean }[]
  >(
    () => [
      {
        id: "__browser__",
        label: "Browser / system printer",
        kind: "browser",
        connected: true,
      },
    ],
    [],
  );
  const printRawBytes = useCallback(
    async (_bytes: Uint8Array) => ({
      success: false,
      error: "No thermal printer is configured for this installation",
    }),
    [],
  );
  const reconnectRole = useCallback(
    async (_role: string) => ({
      success: false,
      error: "No thermal printer is configured for this installation",
    }),
    [],
  );
  const selectedDestination = destinations.find((d) => d.id === selectedPrinter) ?? null;
  const selectedIsThermal =
    !!selectedDestination && selectedDestination.kind === "thermal" && selectedDestination.connected;
  const [zoom, setZoom] = useState(() => window.innerWidth < 640 ? 70 : 100);
  const isMobile = window.innerWidth < 640;
  const { currentBranch } = useBranch();
  const { currentBusiness } = useBusinesses();


  // PDF blob state — the actual PDF that will be previewed, printed, and saved.
  // ADR-0015 (Phase F): blob URL lifecycle now lives inside <SafePdfViewer>;
  // we only hold the raw Blob here so Print / Download / re-open paths can
  // reuse it without re-fetching.
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);

  // ESC/POS bytes state — when the user picks raw thermal output.
  const [escposBytes, setEscposBytes] = useState<Uint8Array | null>(null);
  // True when the resolved policy is ESC/POS — controls whether the
  // Print button streams bytes to a thermal printer (and a Save .bin
  // advanced action is available). Preview itself is ALWAYS PDF.
  const [policyIsEscpos, setPolicyIsEscpos] = useState(false);

  // Print settings — overrides applied to the unified server engine.
  // Default `pdf` + no explicit paperFormat means the resolved policy
  // (P4) decides, which falls back to A4 for unconfigured businesses.
  const [printSettings, setPrintSettings] = useState<PrintSettings>({
    paperFormat: "a4",
    renderMode: "pdf",
  });
  // Track whether the user explicitly overrode the paper format; until
  // they do, we send no paperFormat / format so the server-side policy
  // wins (V1, ADR-0008).
  const [paperOverridden, setPaperOverridden] = useState(false);
  // Resolved policy reported by the server (X-Print-Policy-* headers) so
  // the popover can show "Using business default (A4 PDF)" etc.
  const [policyInfo, setPolicyInfo] = useState<{
    source: string;
    paper: string;
    renderMode: string;
  } | null>(null);


  // Fetch the actual document bytes when dialog opens or settings change.
  useEffect(() => {
    if (!(open && documentType && documentId)) {
      if (!open) {
        setPdfBlob(null);
        setEscposBytes(null);
        setPolicyInfo(null);
        setPolicyIsEscpos(false);
      }
      return;
    }

    setIsLoadingPdf(true);
    setPdfBlob(null);
    setEscposBytes(null);
    setPolicyIsEscpos(false);



    // ALWAYS render a printable PDF for preview, even when the resolved
    // policy is ESC/POS: the server enforces a native printable size
    // (A4/Letter/A5) for non-receipt documents, so the viewer shows a
    // professional, archive-quality document. The thermal byte stream is
    // rendered separately below only when the policy needs it.
    //
    // Both renders go through the printing seam, so the preview is
    // produced by exactly the same code that produces the printed bytes.
    (async () => {
      try {
        const wantsEscposOverride =
          paperOverridden && printSettings.renderMode === "escpos";

        const artifact = await renderDocumentPreview({
          documentType,
          documentId,
          medium: wantsEscposOverride ? "escpos" : "pdf",
          paperFormat: paperOverridden ? printSettings.paperFormat : null,
          branchId: currentBranch?.id ?? null,
          forceRenderMode: wantsEscposOverride,
        });

        if (artifact.policy) setPolicyInfo(artifact.policy);

        if (wantsEscposOverride) {
          // Operator explicitly chose ESC/POS in the popover — the
          // preview is the byte stream itself (advanced path).
          setEscposBytes(artifact.bytes);
          return;
        }

        setPdfBlob(artifact.blob ?? null);

        // Policy says thermal? Render the actual ESC/POS bytes too so the
        // Print button can stream them without a second round trip.
        if (artifact.policy?.renderMode === "escpos") {
          setPolicyIsEscpos(true);
          try {
            const thermal = await renderDocumentPreview({
              documentType,
              documentId,
              medium: "escpos",
              branchId: currentBranch?.id ?? null,
            });
            setEscposBytes(thermal.bytes);
          } catch (escErr) {
            console.warn("Failed to render ESC/POS bytes for thermal print:", escErr);
          }
        }
      } catch (err: unknown) {
        console.error("Failed to generate document:", err);
        toast({
          title: "Preview failed",
          description: normalizeError(err).message || "Could not generate document",
          variant: "destructive",
        });
        onOpenChange(false);
      } finally {
        setIsLoadingPdf(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, documentType, documentId, currentBranch?.id, printSettings.renderMode, printSettings.paperFormat, paperOverridden]);


  // Stage W6 (ADR-0008) + UX-2: re-evaluate the default destination
  // every time the destination list or connection statuses change so a
  // printer that comes online AFTER mount still gets auto-selected.
  // When the policy is thermal, prefer the first CONNECTED thermal
  // destination so the Print button can stream ESC/POS without the user
  // having to touch the picker.
  useEffect(() => {
    if (!open) return;
    if (selectedPrinter !== "__browser__") return;
    if (policyIsEscpos) {
      const thermal = destinations.find((d) => d.kind === "thermal" && d.connected);
      if (thermal) {
        setSelectedPrinter(thermal.id);
        return;
      }
    }
    const firstConnected = destinations.find((d) => d.connected && d.kind !== "browser");
    if (firstConnected) setSelectedPrinter(firstConnected.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, policyIsEscpos, destinations.map((d) => `${d.id}:${d.connected}`).join(",")]);

  // Determine if we're in document mode (server-side render) or legacy HTML mode
  const isPdfMode = !!(documentType && documentId);
  const anyThermalConnected = destinations.some((d) => d.kind === "thermal" && d.connected);
  // Legacy "user explicitly chose ESC/POS in the popover" path. The
  // preview is bytes-only in that case (advanced).
  const isExplicitEscposOverride =
    paperOverridden && printSettings.renderMode === "escpos";
  const isEscposMode = isPdfMode && isExplicitEscposOverride;
  const showLoading =
    externalLoading ||
    isLoadingPdf ||
    (isPdfMode
      ? isEscposMode
        ? !escposBytes
        : !pdfBlob
      : !html);

  /**
   * Render ESC/POS bytes on demand. Used when the operator picks a thermal
   * destination but the resolved policy was PDF (so no byte stream was
   * rendered up front). Without this, picking a thermal printer for an
   * invoice would silently fall back to the browser PDF dialog.
   */
  const fetchEscposBytes = async (): Promise<Uint8Array | null> => {
    if (escposBytes) return escposBytes;
    if (!documentType || !documentId) return null;
    try {
      const artifact = await renderDocumentPreview({
        documentType,
        documentId,
        medium: "escpos",
        forceRenderMode: true,
        paperFormat: printSettings.paperFormat === "58mm" ? "58mm" : "80mm",
        branchId: currentBranch?.id ?? null,
      });
      setEscposBytes(artifact.bytes);
      return artifact.bytes;
    } catch (err) {
      console.warn("On-demand ESC/POS render failed:", err);
      return null;
    }
  };


  const handlePrint = async () => {
    // Wave B3 (Plan P1) — enqueue rather than block. The Print button
    // stays live; every click bumps `pendingPrints` and hands another
    // job to the underlying transport. `printPdfInPage` serialises PDF
    // jobs in a module-scoped FIFO so overlapping browser print dialogs
    // are impossible. Thermal jobs go through `printRawBytes`, itself
    // serialised per-endpoint by `AgentClient._withEndpointLock` and
    // the agent-side `endpointQueues` in `agent/src/routes/print.ts`.
    setPendingPrints((n) => n + 1);
    // Plan P3 Step 1 — one UUID per Print click; passed to both thermal
    // and PDF branches so a rapid double-click collapses on the ledger's
    // `(business_id, correlation_id)` uniqueness instead of racing.
    const clickIdempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const wantsThermal = isEscposMode || policyIsEscpos || selectedIsThermal;
      let bytes = escposBytes;
      if (wantsThermal && !bytes && selectedIsThermal) {
        bytes = await fetchEscposBytes();
      }
      let canStream = wantsThermal && !!bytes && selectedIsThermal;

      if (wantsThermal && !canStream && !selectedIsThermal) {
        const offlineThermal = destinations.find((d) => d.kind === "thermal" && !d.connected);
        if (offlineThermal) {
          const r = await reconnectRole("receipt_printer");
          if (r.success) {
            setSelectedPrinter(offlineThermal.id);
            if (!bytes) bytes = await fetchEscposBytes();
            canStream = !!bytes;
          }
        }
      }

      if (canStream && bytes) {
        // Wave B3 (Plan P2 Step 1) — ledger-cover interactive thermal
        // prints so the audit view sees every dispatch, not just the
        // auto_print branch.
        const ledger = await openInteractiveJob({
          documentType: documentType ?? "unknown",
          documentId: documentId ?? null,
          intent: "receipt",
          format: "escpos",
          transport: "thermal",
          businessId: currentBusiness?.id ?? null,
          branchId: currentBranch?.id ?? null,
          correlationId: clickIdempotencyKey,
        });
        try {
          const result = await printRawBytes(bytes);
          if (result.success) {
            await ledger.markSent(null);
            await ledger.markAcked();
            toast({
              title: "Sent to printer",
              description: `${selectedDestination?.label ?? "Thermal printer"} · ${bytes.length} bytes`,
            });
          } else {
            await ledger.markFailed(result.error || "Printer reported an error");
            toast({
              title: "Print failed",
              description: result.error || "Printer reported an error",
              variant: "destructive",
            });
          }
        } catch (err) {
          await ledger.markFailed((err as Error).message);
          throw err;
        }
      } else if (wantsThermal && !selectedIsThermal) {
        toast({
          title: "Thermal printer unavailable",
          description:
            destinations.some((d) => d.kind === "thermal")
              ? "The configured thermal printer is offline. Use Reconnect printer above, or pick another destination."
              : "No thermal printer is registered for this register. Configure one in Settings → Hardware.",
          variant: "destructive",
        });
      } else if (pdfBlob) {
        // Wave B3 (Plan P2 Step 1) — ledger-cover interactive PDF
        // prints. `printPdfInPage`'s FIFO queue guarantees the browser
        // print dialog opens for this job before the next one starts,
        // so `markSent` after `await` is a truthful ack.
        const ledger = await openInteractiveJob({
          documentType: documentType ?? "unknown",
          documentId: documentId ?? null,
          intent: "a4_document",
          format: "pdf",
          businessId: currentBusiness?.id ?? null,
          branchId: currentBranch?.id ?? null,
          correlationId: clickIdempotencyKey,
        });
        try {
          await printPdfInPage(pdfBlob);
          await ledger.markSent(null);
          await ledger.markAcked();
          toast({ title: "Print dialog opened" });
        } catch (err) {
          await ledger.markFailed((err as Error).message);
          throw err;
        }
      } else {
        toast({ title: "Nothing to print", description: "Document is not ready yet", variant: "destructive" });
      }

    } catch (error) {
      console.error("Print error:", error);
      toast({ title: "Print failed", description: "An error occurred while printing", variant: "destructive" });
    } finally {
      setPendingPrints((n) => Math.max(0, n - 1));
    }
  };


  const handleReconnectPrinter = async () => {
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
  };

  // Quick-print silently to a registered destination is now handled by
  // the unified hardware path elsewhere (POSTerminal auto-print, etc.).

  const handleSavePDF = async () => {
    setIsSavingPDF(true);
    try {
      if (pdfBlob) {
        // UX-1: Save is ALWAYS the PDF, regardless of print transport.
        // Raw ESC/POS bytes are an advanced action below.
        downloadPdfBlob(pdfBlob, `${filename}.pdf`);
        toast({ title: "PDF downloaded" });
      } else if (isEscposMode && escposBytes) {
        // Legacy: user explicitly switched the popover to ESC/POS — no
        // PDF available. Save bytes as .bin.
        const blob = new Blob([escposBytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = window.document.createElement("a");
        a.href = url;
        a.download = `${filename}.bin`;
        window.document.body.appendChild(a);
        a.click();
        window.document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 100);
        toast({ title: "Thermal bytes downloaded", description: `${escposBytes.length} bytes saved as ${filename}.bin` });
      } else {
        toast({ title: "Nothing to save", description: "Document is not ready yet", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Save failed", description: "An error occurred while saving", variant: "destructive" });
    } finally {
      setIsSavingPDF(false);
    }
  };

  /** UX-1: Advanced — download raw ESC/POS bytes for driver debugging. */
  const handleDownloadEscpos = () => {
    if (!escposBytes) {
      toast({ title: "Bytes not ready", description: "ESC/POS bytes are still being generated.", variant: "destructive" });
      return;
    }
    const blob = new Blob([escposBytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement("a");
    a.href = url;
    a.download = `${filename}.bin`;
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
    toast({ title: "Raw ESC/POS downloaded", description: `${escposBytes.length} bytes saved as ${filename}.bin` });
  };

  const handleZoomIn = () => setZoom((z) => Math.min(200, z + 25));
  const handleZoomOut = () => setZoom((z) => Math.max(50, z - 25));

  /**
   * ADR-0015 — open the PDF in a dedicated Electron BrowserWindow (or a
   * new browser tab on web). Useful as the supported escape hatch when
   * the in-dialog iframe can't render (CSP overrides, plugin policy,
   * very large PDFs, multi-monitor users wanting a side-by-side view).
   */
  const isElectronRuntime = runtimeIsElectron();
  const handleOpenInWindow = async () => {
    if (!pdfBlob) return;
    const res = await openPdfPreview(pdfBlob, { title, filename });
    if (!res.ok) {
      toast({
        title: "Could not open preview window",
        description: res.error || "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-4xl max-h-[90vh] flex flex-col p-4 sm:p-6">
        <DialogHeader className="no-print">
          <DialogTitle className="text-base sm:text-lg truncate">{title}</DialogTitle>
        </DialogHeader>

        {/* Zoom controls */}
        <div className="no-print flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-0">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-8 w-8 sm:h-9 sm:w-9" onClick={handleZoomOut} disabled={zoom <= 50}>
              <ZoomOut className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </Button>
            <span className="text-xs sm:text-sm text-muted-foreground w-10 sm:w-12 text-center">{zoom}%</span>
            <Button variant="outline" size="icon" className="h-8 w-8 sm:h-9 sm:w-9" onClick={handleZoomIn} disabled={zoom >= 200}>
              <ZoomIn className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </Button>
            {isPdfMode && (
              <PrintSettingsPopover
                value={printSettings}
                onChange={(next) => {
                  setPrintSettings(next);
                  setPaperOverridden(true);
                }}
                disabled={isLoadingPdf}
              />
            )}
            {isPdfMode && policyInfo && !paperOverridden && (
              <span
                className="text-[11px] text-muted-foreground hidden md:inline"
                title={`Resolved from ${policyInfo.source} policy`}
              >
                {policyInfo.source === "default" ? "Default" : policyInfo.source === "branch" ? "Branch policy" : "Business policy"}
                {": "}{policyInfo.paper.toUpperCase()} · {policyInfo.renderMode.toUpperCase()}
              </span>
            )}
          </div>

          {/* Stage W6: unified destination picker — same source for POS and non-POS. */}
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {destinations.length > 1 ? (
              <>
                <span className="text-xs sm:text-sm text-muted-foreground hidden sm:inline">Destination:</span>
                <Select value={selectedPrinter} onValueChange={setSelectedPrinter}>
                  <SelectTrigger className="w-full sm:w-[220px] h-8 sm:h-9 text-xs sm:text-sm">
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.label}
                        {d.kind !== 'browser' && (d.connected ? ' • online' : ' • offline')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : (
              <div className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground">
                <AlertCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span>No registered printers — using browser print</span>
              </div>
            )}
          </div>
        </div>

        {/* UX-2: transport chip — preview is always a printable PDF;
            this line tells the user what the Print button will actually
            do based on the resolved policy + connected hardware. */}
        {isPdfMode && policyIsEscpos && !isEscposMode && (
          <div className="no-print text-[11px] sm:text-xs text-muted-foreground flex items-center gap-2 -mt-1">
            <Printer className="h-3.5 w-3.5" />
            {selectedIsThermal ? (
              <span>
                Print will stream to <strong>{selectedDestination?.label}</strong> (thermal receipt). Preview/Save = A4 PDF.
              </span>
            ) : anyThermalConnected ? (
              <span>Pick the connected thermal printer to send the receipt — or use Save PDF for the A4 copy.</span>
            ) : (
              <span>Thermal printer configured but offline. Print will report an error; Save PDF still works.</span>
            )}
          </div>
        )}

        {/* Preview area */}
        <div className="print-content flex-1 min-h-[250px] sm:min-h-[400px] max-h-[50vh] sm:max-h-[60vh] overflow-auto border rounded-lg bg-white">
          {showLoading ? (
            <div className="flex flex-col items-center justify-center h-[250px] sm:h-[400px]">
              <Loader2 className="h-6 w-6 sm:h-8 sm:w-8 animate-spin text-muted-foreground mb-2" />
              <span className="text-xs sm:text-sm text-muted-foreground">Generating preview...</span>
            </div>
          ) : isEscposMode && escposBytes ? (
            /* ESC/POS preview — thermal bytes can't be rendered in-browser.
               Show readiness + the right next action for the chosen
               destination. The Print button below streams to the printer. */
            <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-3">
              <Printer className="h-10 w-10 text-muted-foreground" />
              <div className="text-sm font-medium">
                {selectedIsThermal
                  ? `Ready to print to ${selectedDestination?.label}`
                  : selectedDestination?.kind === "thermal"
                    ? `${selectedDestination.label} is offline`
                    : "Pick a thermal printer to print"}
              </div>
              <div className="text-xs text-muted-foreground max-w-sm">
                {escposBytes.length.toLocaleString()} bytes generated for {printSettings.paperFormat}.
                {selectedIsThermal
                  ? " Click Print to stream them to the printer."
                  : selectedDestination?.kind === "thermal"
                    ? " Reconnect the printer or pick another destination."
                    : " Select a connected thermal printer in the destination list, or switch to A4/PDF for browser printing."}
              </div>
              {selectedDestination?.kind === "thermal" && !selectedDestination.connected && (
                <Button size="sm" variant="outline" onClick={handleReconnectPrinter}>
                  <Printer className="h-3.5 w-3.5 mr-2" />
                  Reconnect printer
                </Button>
              )}
            </div>
          ) : isPdfMode && pdfBlob ? (
            /* ADR-0015 — unified Electron-safe PDF viewer. In Electron the
               blob is rendered via the dedicated `preview:open-pdf` window;
               on web/PWA it falls back to an instrumented iframe. */
            <SafePdfViewer
              pdfBlob={pdfBlob}
              title={title}
              filename={filename}
              className="w-full h-full min-h-[250px] sm:min-h-[400px] flex flex-col"
            />
          ) : html ? (
            /* Legacy HTML preview — wrapped in SafeHtmlPreview so a
               same-origin srcDoc render failure surfaces a recovery card
               instead of a blank pane (ADR-0015 re-audit, step C). */
            <div
              style={{
                transform: `scale(${zoom / 100})`,
                transformOrigin: "top left",
                width: `${10000 / zoom}%`,
              }}
            >
              <SafeHtmlPreview
                html={html}
                title={title || "Print Preview"}
                filename={filename}
                className="w-full min-h-[250px] sm:min-h-[400px]"
                style={{
                  height: `${(isMobile ? 250 : 400) * (100 / zoom)}px`,
                  border: "none",
                }}
              />
            </div>
          ) : null}
        </div>

        {communication && (
          <div className="no-print border-t pt-3 -mx-1 px-1">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-xs text-muted-foreground">Send this document</span>
              <DocumentCommunicationBar {...communication} />
            </div>
            <div className="mt-3">
              <DocumentCommunicationHistory
                entityType={communication.entityType}
                entityId={communication.entityId}
              />
            </div>
          </div>
        )}

        <DialogFooter className="no-print flex flex-col-reverse sm:flex-row gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto h-9 text-sm">
            Cancel
          </Button>

          <Button
            variant={isMobile ? "default" : "outline"}
            onClick={handleSavePDF}
            disabled={isSavingPDF || showLoading}
            className="w-full sm:w-auto h-9 text-sm"
          >
            {isSavingPDF ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
            Save PDF
          </Button>

          {isPdfMode && pdfBlob && (
            <Button
              variant="outline"
              onClick={handleOpenInWindow}
              disabled={showLoading}
              className="w-full sm:w-auto h-9 text-sm"
              title={
                isElectronRuntime
                  ? "Open this PDF in a dedicated preview window"
                  : "Open this PDF in a new browser tab"
              }
            >
              {isElectronRuntime ? "Open in window" : "Open in tab"}
            </Button>
          )}

          {/* Advanced — download raw ESC/POS bytes for printer driver
              debugging only. Hidden by default; press the small "·"
              long-press / hover the title to reveal. */}
          {policyIsEscpos && escposBytes && !isEscposMode && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownloadEscpos}
              disabled={showLoading}
              className="hidden sm:inline-flex h-8 px-2 text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
              title="Advanced: download the raw ESC/POS command stream (printer driver debugging only)"
            >
              Raw .bin
            </Button>
          )}

          <Button
            onClick={handlePrint}
            // Wave B3 (Plan P1) — button stays live during in-flight
            // prints so rapid clicks enqueue instead of being swallowed
            // by the DOM. `showLoading` still gates during initial PDF
            // fetch because there is literally nothing to enqueue yet.
            disabled={showLoading}
            variant={isMobile ? "outline" : "default"}
            className="w-full sm:w-auto h-9 text-sm"
          >
            {isPrinting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />}
            {pendingPrints > 1 ? `Print (${pendingPrints} queued)` : isPrinting ? "Printing…" : "Print"}
          </Button>

        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
