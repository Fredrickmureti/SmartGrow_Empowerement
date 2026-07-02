import { normalizeError } from "@/services/resilience";
/**
 * ProductIdentifiersEditor — manages rows of `product_identifiers` for a
 * single product. Supports two modes:
 *
 *   1. Edit mode (productId provided): loads existing rows from Supabase
 *      and persists Add / Update / Delete immediately.
 *
 *   2. Create mode (productId == null): holds rows in local state; call
 *      the imperative ref method `commit(newProductId)` after the parent
 *      finishes inserting the product to bulk-insert the pending rows.
 *
 * Includes "Scan to add" — opens the device camera and uses the native
 * BarcodeDetector when available, falling back to ZXing. The decoded
 * string is dropped straight into a new identifier row.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Plus, Trash2, ScanLine, Loader2, Star, StarOff, Camera, X, AlertTriangle, Smartphone, CheckCircle2 } from "lucide-react";
import { BarcodeInputField, type BarcodeInputFieldHandle } from "@/components/scanner/BarcodeInputField";
import { useWorkspaceScanner } from "@/contexts/ScannerWorkspaceContext";
import { useScanTarget } from "@/hooks/pos/useScanTarget";
import { scanFeedbackBus } from "@/services/scanner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "@/hooks/use-toast";

export type IdentifierKind = "gtin" | "sku" | "pack" | "supplier" | "internal" | "plu" | "alias";

const KIND_OPTIONS: Array<{ value: IdentifierKind; label: string }> = [
  { value: "gtin", label: "Barcode (GTIN/EAN/UPC)" },
  { value: "pack", label: "Pack / Case code" },
  { value: "supplier", label: "Supplier code" },
  { value: "internal", label: "Internal" },
  { value: "plu", label: "PLU (produce)" },
  { value: "alias", label: "Alias" },
  { value: "sku", label: "SKU (mirror)" },
];

interface IdentifierRow {
  id?: string; // present only for persisted rows
  code: string;
  kind: IdentifierKind;
  is_primary: boolean;
  pack_quantity: number | null;
  _dirty?: boolean;
}

export interface ProductIdentifiersEditorHandle {
  /** Persist pending rows after the parent creates the product. */
  commit: (productId: string) => Promise<void>;
  /** True if at least one row was added in create mode. */
  hasPending: () => boolean;
}

interface Props {
  productId: string | null;
  organizationId: string;
  businessId: string;
  /** Pre-fill the first row with this barcode (from "Unknown barcode → Create product"). */
  initialBarcode?: string;
}

export const ProductIdentifiersEditor = forwardRef<ProductIdentifiersEditorHandle, Props>(
  function ProductIdentifiersEditor({ productId, organizationId, businessId, initialBarcode }, ref) {
    const [rows, setRows] = useState<IdentifierRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [scanOpen, setScanOpen] = useState(false);
    const [scanError, setScanError] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const rafRef = useRef<number | null>(null);
    const zxingRef = useRef<{ stop: () => void } | null>(null);
    const initialAppliedRef = useRef(false);
    const seededRef = useRef(false);
    const fieldRefs = useRef<Array<BarcodeInputFieldHandle | null>>([]);
    const wasConnectedRef = useRef(false);

    // Workspace-scoped scanner session — owned by ScannerWorkspaceProvider
    // in AuthenticatedShell, NOT by this editor. Means the phone paired on
    // the Products toolbar (or any other form in this workspace) stays
    // paired across every Add Item open/close and across every product
    // saved during this onboarding sitting.
    const workspaceScanner = useWorkspaceScanner();
    const connectedCount = workspaceScanner.connectedCount;
    const isPhonePaired = workspaceScanner.isPaired;
    const scannerSessionId = workspaceScanner.session?.sessionId ?? null;

    // Load existing rows when in edit mode
    useEffect(() => {
      if (!productId) {
        setRows([]);
        return;
      }
      let cancelled = false;
      setLoading(true);
      (async () => {
        const { data, error } = await supabase
          .from("product_identifiers")
          .select("id, code, kind, is_primary, pack_quantity")
          .eq("product_id", productId)
          .order("is_primary", { ascending: false })
          .order("created_at", { ascending: true });
        if (cancelled) return;
        setLoading(false);
        if (error) {
          toast({
            title: "Could not load barcodes",
            description: normalizeError(error).message,
            variant: "destructive",
          });
          return;
        }
        setRows(
          (data || []).map((r: any) => ({
            id: r.id,
            code: r.code,
            kind: r.kind,
            is_primary: !!r.is_primary,
            pack_quantity: r.pack_quantity,
          })),
        );
      })();
      return () => {
        cancelled = true;
      };
    }, [productId]);

    // Apply initialBarcode once (create mode only)
    useEffect(() => {
      if (initialAppliedRef.current) return;
      if (!initialBarcode || productId) return;
      initialAppliedRef.current = true;
      seededRef.current = true;
      setRows((prev) => [
        { code: initialBarcode, kind: "gtin", is_primary: true, pack_quantity: null, _dirty: true },
        ...prev,
      ]);
    }, [initialBarcode, productId]);

    // Auto-seed a single empty barcode row in create-mode so a
    // <BarcodeInputField> is mounted and ready to receive scans even before
    // the user clicks anywhere. Without this the editor renders an empty
    // state with no scan target, and the very first scan after pairing is
    // silently dropped.
    useEffect(() => {
      if (seededRef.current) return;
      if (productId) return;
      if (loading) return;
      if (rows.length > 0) return;
      seededRef.current = true;
      setRows([{ code: "", kind: "gtin", is_primary: true, pack_quantity: null, _dirty: true }]);
    }, [productId, loading, rows.length]);

    // When a phone pairs (0 → ≥1 device), focus the first empty barcode row
    // so the priority-10 focused-target path is live for the next scan.
    useEffect(() => {
      const wasConnected = wasConnectedRef.current;
      wasConnectedRef.current = isPhonePaired;
      if (!isPhonePaired || wasConnected) return;
      const idx = rows.findIndex((r) => !r.code.trim());
      const target = idx >= 0 ? fieldRefs.current[idx] : fieldRefs.current[0];
      setTimeout(() => target?.focus(), 50);
    }, [isPhonePaired, rows]);

    // Editor-level fallback scan target (priority 5). Active whenever a
    // scanner session exists, so scans land here even if focus moved to a
    // non-barcode field (e.g. Product Name). Focused <BarcodeInputField>
    // (priority 10) still wins via scanRouter precedence.
    //
    // IMPORTANT (audit fix, 2026-05-19): this target NEVER appends a new
    // row on scan. It either (a) fills the first empty row, (b) toasts
    // "already in the list" if the code matches a local row, or
    // (c) toasts "already used by X" if `pos_resolve_barcode` finds the
    // code on a different product. Appending requires an explicit
    // "+ Add identifier" click. Without this, advancing focus away from
    // the barcode field caused surprise duplicate rows.
    useScanTarget({
      active: !!scannerSessionId,
      priority: 5,
      workflow: "identity",
      label: "ProductIdentifiersEditor fallback",
      onScan: (e) => {
        const code = e.code.trim();
        if (!code) return;
        let filledRow = false;
        setRows((prev) => {
          if (prev.some((r) => r.code.trim().toLowerCase() === code.toLowerCase())) {
            toast({ title: "Already in the list", description: code });
            return prev;
          }
          const emptyIdx = prev.findIndex((r) => !r.code.trim());
          if (emptyIdx < 0) {
            // No empty row — refuse to append silently. Identity workflow:
            // user must explicitly click "+ Add identifier" to create one.
            toast({
              title: "No empty barcode slot",
              description: "Click \"+ Add identifier\" to add another barcode row.",
            });
            return prev;
          }
          filledRow = true;
          return prev.map((r, i) =>
            i === emptyIdx ? { ...r, code, kind: "gtin", _dirty: true } : r,
          );
        });
        if (!filledRow) return;
        // Authoritative cross-product duplicate check. If the code already
        // belongs to a different product, surface it loudly and clear the
        // row so the user can't unknowingly Save a colliding identifier.
        void (async () => {
          try {
            const { data } = await supabase.rpc("pos_resolve_barcode" as any, {
              p_business_id: businessId,
              p_branch_id: null,
              p_code: code,
            } as any);
            const row = Array.isArray(data) && data.length > 0 ? (data[0] as any) : null;
            if (row && row.product_id && row.product_id !== productId) {
              toast({
                title: "Barcode already used",
                description: `Used by ${row.name ?? "another product"}. Cleared from the row.`,
                variant: "destructive",
              });
              setRows((prev) =>
                prev.map((r) =>
                  r.code.trim().toLowerCase() === code.toLowerCase() && !r.id
                    ? { ...r, code: "" }
                    : r,
                ),
              );
              scanFeedbackBus.emit({ kind: "error", raw: code, source: "field", detail: "duplicate" });
              return;
            }
            scanFeedbackBus.emit({ kind: "ok", raw: code, source: "field" });
          } catch {
            // Network/RPC failure — leave the row filled; submit-time
            // upsert is still backed by the DB unique constraint.
            scanFeedbackBus.emit({ kind: "ok", raw: code, source: "field" });
          }
        })();
      },
    });


    useImperativeHandle(ref, () => ({
      hasPending: () => rows.some((r) => !r.id && r.code.trim().length > 0),
      commit: async (newProductId: string) => {
        const pending = rows
          .filter((r) => !r.id && r.code.trim().length > 0)
          .map((r) => ({
            organization_id: organizationId,
            business_id: businessId,
            product_id: newProductId,
            code: r.code.trim(),
            kind: r.kind,
            is_primary: r.is_primary,
            pack_quantity: r.kind === "pack" ? r.pack_quantity : null,
          }));
        if (pending.length === 0) return;
        // Plain insert (no ignoreDuplicates). The DB unique constraint on
        // (business_id, code_norm, kind) is the authoritative collision
        // detector — surface a clear error instead of silently dropping
        // rows that already belong to a different product.
        const { error } = await supabase
          .from("product_identifiers")
          .insert(pending);
        if (error) {
          console.error("[ProductIdentifiersEditor] commit failed", error);
          const isDup = /duplicate key|unique constraint/i.test(error.message || "");
          toast({
            title: isDup ? "Some barcodes already belong to another product" : "Some barcodes could not be saved",
            description: normalizeError(error).message,
            variant: "destructive",
          });
        }
      },
    }));

    const addRow = (initialCode = "", kind: IdentifierKind = "gtin") => {
      setRows((prev) => {
        const hasPrimary = prev.some((r) => r.is_primary);
        return [
          ...prev,
          {
            code: initialCode,
            kind,
            is_primary: !hasPrimary,
            pack_quantity: null,
            _dirty: true,
          },
        ];
      });
    };

    const updateRow = async (idx: number, patch: Partial<IdentifierRow>) => {
      const target = rows[idx];
      if (!target) return;
      // optimistic local update
      setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch, _dirty: true } : r)));
      // if it's a persisted row and we have productId, save immediately
      if (target.id && productId) {
        const merged = { ...target, ...patch };
        const { error } = await supabase
          .from("product_identifiers")
          .update({
            code: merged.code.trim(),
            kind: merged.kind,
            is_primary: merged.is_primary,
            pack_quantity: merged.kind === "pack" ? merged.pack_quantity : null,
          })
          .eq("id", target.id);
        if (error) {
          toast({ title: "Save failed", description: normalizeError(error).message, variant: "destructive" });
        }
      }
    };

    const setPrimary = async (idx: number) => {
      const target = rows[idx];
      if (!target) return;
      setRows((prev) => prev.map((r, i) => ({ ...r, is_primary: i === idx })));
      if (productId) {
        // Demote all then promote one — done in two statements to avoid uniqueness pitfalls.
        await supabase.from("product_identifiers").update({ is_primary: false }).eq("product_id", productId);
        if (target.id) {
          await supabase.from("product_identifiers").update({ is_primary: true }).eq("id", target.id);
        }
      }
    };

    const deleteRow = async (idx: number) => {
      const target = rows[idx];
      if (!target) return;
      setRows((prev) => prev.filter((_, i) => i !== idx));
      if (target.id) {
        const { error } = await supabase.from("product_identifiers").delete().eq("id", target.id);
        if (error) {
          toast({ title: "Delete failed", description: normalizeError(error).message, variant: "destructive" });
        }
      }
    };

    // ---------- Camera scan-to-add ----------
    const stopCamera = useCallback(() => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (zxingRef.current) {
        try {
          zxingRef.current.stop();
        } catch {
          /* ignore */
        }
        zxingRef.current = null;
      }
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop();
        streamRef.current = null;
      }
    }, []);

    useEffect(() => stopCamera, [stopCamera]);

    const handleDecoded = useCallback(
      (code: string) => {
        const norm = code.trim();
        if (!norm) return;
        // dedupe against existing
        if (rows.some((r) => r.code.trim().toLowerCase() === norm.toLowerCase())) {
          toast({ title: "Already in the list", description: norm });
          return;
        }
        addRow(norm, "gtin");
        toast({ title: "Barcode added", description: norm });
        setScanOpen(false);
        stopCamera();
      },
      [rows, stopCamera],
    );

    const startCamera = useCallback(async () => {
      setScanError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }

        const BD = (window as any).BarcodeDetector;
        if (BD) {
          let detector: any;
          try {
            const formats = await BD.getSupportedFormats();
            detector = new BD({
              formats: formats.length
                ? formats
                : ["ean_13", "ean_8", "code_128", "code_39", "qr_code", "upc_a", "upc_e", "itf"],
            });
          } catch {
            detector = new BD();
          }
          const tick = async () => {
            if (!videoRef.current) return;
            try {
              const results = await detector.detect(videoRef.current);
              if (results && results.length > 0 && results[0].rawValue) {
                handleDecoded(results[0].rawValue);
                return;
              }
            } catch {
              /* frame may not be ready */
            }
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        // ZXing fallback
        const mod: any = await import("@zxing/browser" as any).catch(() => null);
        if (!mod) {
          setScanError("Barcode scanning is not supported in this browser.");
          return;
        }
        const reader = new mod.BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(stream, videoRef.current!, (result: any) => {
          if (result) handleDecoded(result.getText());
        });
        zxingRef.current = controls as unknown as { stop: () => void };
      } catch (err: any) {
        setScanError(err?.message || "Camera permission denied.");
      }
    }, [handleDecoded]);

    useEffect(() => {
      if (scanOpen) {
        void startCamera();
      } else {
        stopCamera();
      }
    }, [scanOpen, startCamera, stopCamera]);

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-sm font-medium">Barcodes & Identifiers</Label>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant={isPhonePaired ? "default" : "outline"}
              size="sm"
              onClick={() => workspaceScanner.openPairing("Product onboarding — scan barcodes into the focused row")}
              className={
                "h-7 px-2 text-xs " +
                (isPhonePaired
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/20"
                  : "")
              }
              title={isPhonePaired ? "Phone connected — scans land in the focused row" : "Pair your phone as a scanner"}
            >
              {isPhonePaired ? (
                <>
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Phone ready
                </>
              ) : (
                <>
                  <Smartphone className="h-3 w-3 mr-1" /> Pair phone
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setScanOpen((v) => !v)}
              className="h-7 px-2 text-xs"
            >
              {scanOpen ? <X className="h-3 w-3 mr-1" /> : <Camera className="h-3 w-3 mr-1" />}
              <span className="hidden xs:inline">{scanOpen ? "Close camera" : "Scan to add"}</span>
              <span className="xs:hidden">{scanOpen ? "Close" : "Scan"}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addRow()}
              className="h-7 px-2 text-xs"
            >
              <Plus className="h-3 w-3 mr-1" /> Add
            </Button>
          </div>
        </div>

        {/* QR pairing dialog is rendered once at the workspace level by
            ScannerWorkspaceProvider — calling openPairing() above opens it. */}




        {scanOpen && (
          <div className="rounded-md border bg-black/90 overflow-hidden">
            <video
              ref={videoRef}
              className="w-full h-40 object-cover"
              playsInline
              muted
            />
            {scanError && (
              <Alert variant="destructive" className="rounded-none border-0">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">{scanError}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading barcodes…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground flex items-center gap-2">
            <ScanLine className="h-3.5 w-3.5" />
            No barcodes yet. The SKU is auto-registered as scannable. Add GTIN/EAN barcodes
            here to scan additional codes printed on packaging.
          </div>
        ) : (
          <div className="space-y-1.5">
            {rows.map((row, idx) => (
              <div key={row.id ?? `new-${idx}`} className="flex flex-wrap items-start gap-1.5 rounded-md border border-transparent sm:border-0 p-1.5 sm:p-0 bg-muted/30 sm:bg-transparent">
                <div className="w-full sm:flex-1 min-w-0">
                  <BarcodeInputField
                    ref={(h) => { fieldRefs.current[idx] = h; }}
                    value={row.code}
                    onChange={(next) => updateRow(idx, { code: next })}
                    businessId={businessId}
                    scannerConnected={isPhonePaired}
                    checkUniqueness={row.kind === "gtin" || row.kind === "sku"}
                    excludeProductId={productId ?? undefined}
                    className="h-8 text-sm font-mono w-full"
                    placeholder="Scan or type code"
                  />
                </div>
                <Select
                  value={row.kind}
                  onValueChange={(v) => updateRow(idx, { kind: v as IdentifierKind })}
                >
                  <SelectTrigger className="h-8 flex-1 sm:flex-none sm:w-[170px] text-xs min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {row.kind === "pack" && (
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={row.pack_quantity ?? ""}
                    placeholder="qty"
                    className="h-8 w-16 text-xs"
                    onChange={(e) =>
                      updateRow(idx, {
                        pack_quantity: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPrimary(idx)}
                  title={row.is_primary ? "Primary" : "Set primary"}
                >
                  {row.is_primary ? (
                    <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
                  ) : (
                    <StarOff className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => deleteRow(idx)}
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
);
