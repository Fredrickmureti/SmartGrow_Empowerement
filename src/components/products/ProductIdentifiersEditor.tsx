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
import { useCameraDecoder } from "@/services/scanner/camera/useCameraDecoder";
import { supabase } from "@/integrations/supabase/client";
import {
  writeIdentifier,
  identifierWriteMessage,
  retireIdentifier,
} from "@/features/products/identity/writeIdentifier";
import { activeIdentifiersForProduct } from "@/features/products/identity/activeIdentifiers";

import { resolveProductIdentityOnce } from "@/hooks/inventory/useResolveProductIdentity";
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
  /**
   * Phase D — packaging level this identifier belongs to. Replaces the
   * dropped `pack_quantity` free-number column: the level's own
   * `qty_in_base_uom` is now the single source of pack size.
   */
  packaging_id: string | null;
  _dirty?: boolean;
}

export interface ProductIdentifiersEditorHandle {
  /** Persist pending rows after the parent creates the product. */
  commit: (productId?: string) => Promise<void>;
  /**
   * Payload for the single-transaction product save
   * (`save_product_atomic`). The RPC routes every row through
   * `upsert_product_identifier`, so the identity invariants stay in one place.
   */
  collect: () => IdentifierInput[];
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
    const videoRef = useRef<HTMLVideoElement>(null);
    const initialAppliedRef = useRef(false);
    const seededRef = useRef(false);
    const fieldRefs = useRef<Array<BarcodeInputFieldHandle | null>>([]);
    const wasConnectedRef = useRef(false);
    // Live mirror of `rows` — saves read from here, never from a stale
    // render-time closure.
    const rowsRef = useRef<IdentifierRow[]>([]);
    rowsRef.current = rows;
    // Per-row write sequence: only the newest issued save may settle.
    const writeSeqRef = useRef<Map<string, number>>(new Map());
    // Last code successfully persisted per identifier id.
    const lastSavedRef = useRef<Map<string, string>>(new Map());

    // Workspace-scoped scanner session — owned by ScannerWorkspaceProvider
    // in AuthenticatedShell, NOT by this editor. Means the phone paired on
    // the Products toolbar (or any other form in this workspace) stays
    // paired across every Add Item open/close and across every product
    // saved during this onboarding sitting.
    const workspaceScanner = useWorkspaceScanner();
    const connectedCount = workspaceScanner.connectedCount;
    const isPhonePaired = workspaceScanner.isPaired;
    const scannerSessionId = workspaceScanner.session?.sessionId ?? null;

    // Phase D — packaging ladder for the level picker. An identifier binds
    // to a level (`packaging_id`); the level owns the pack size.
    const [packagingLevels, setPackagingLevels] = useState<
      Array<{ id: string; name: string; qty_in_base_uom: number }>
    >([]);
    useEffect(() => {
      if (!productId) {
        setPackagingLevels([]);
        return;
      }
      let cancelled = false;
      (async () => {
        const { data } = await supabase
          .from("product_packaging")
          .select("id, name, qty_in_base_uom")
          .eq("product_id", productId)
          .order("qty_in_base_uom", { ascending: true });
        if (cancelled) return;
        setPackagingLevels(
          (data ?? []).map((r: any) => ({
            id: r.id,
            name: r.name,
            qty_in_base_uom: Number(r.qty_in_base_uom) || 1,
          })),
        );
      })();
      return () => {
        cancelled = true;
      };
    }, [productId]);

    // Load existing rows when in edit mode
    useEffect(() => {
      if (!productId) {
        setRows([]);
        return;
      }
      let cancelled = false;
      setLoading(true);
      (async () => {
        // Lifecycle-faithful read: retiring an identifier archives the row,
        // so an unfiltered select renders retired codes as live ones.
        const { data, error } = await activeIdentifiersForProduct(
          productId,
          "id, code, kind, is_primary, packaging_id",
        );

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
            packaging_id: r.packaging_id ?? null,
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
        { code: initialBarcode, kind: "gtin", is_primary: true, packaging_id: null, _dirty: true },
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
      setRows([{ code: "", kind: "gtin", is_primary: true, packaging_id: null, _dirty: true }]);
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
    // (c) toasts "already used by X" if `resolve_product_identity` finds the
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
        let filledIdx = -1;
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
          filledIdx = emptyIdx;
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
            const decision = await resolveProductIdentityOnce({
              businessId,
              code,
            });
            const identity =
              decision.kind === "resolved" || decision.kind === "ambiguous"
                ? decision.identity
                : null;
            if (identity && identity.productId && identity.productId !== productId) {
              toast({
                title: "Barcode already used",
                description: `Used by ${identity.productName || "another product"}. Cleared from the row.`,
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
            // A confirmed scan carries a complete code — persist it now.
            if (filledIdx >= 0) await persistRow(filledIdx, { code });
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
      collect: (): IdentifierInput[] =>
        rowsRef.current
          .filter((r) => r.code.trim().length > 0 && (r._dirty || !r.id))
          .map((r) => ({
            id: r.id ?? null,
            code: r.code.trim(),
            kind: r.kind,
            is_primary: r.is_primary,
            packaging_id: r.packaging_id,
          })),
      commit: async (newProductId?: string) => {
        const targetProductId = newProductId ?? productId;
        if (!targetProductId) return;
        const live = rowsRef.current;

        // Flush edits to already-persisted rows first (form Save on an
        // existing product): typing no longer writes per keystroke.
        for (let i = 0; i < live.length; i += 1) {
          const r = live[i];
          if (r.id && r._dirty && r.code.trim()) {
            await persistRow(i);
          }
        }

        const pending = live
          .filter((r) => !r.id && r.code.trim().length > 0)
          .map((r) => ({
            organization_id: organizationId,
            business_id: businessId,
            product_id: targetProductId,
            code: r.code.trim(),
            kind: r.kind,
            is_primary: r.is_primary,
            packaging_id: r.packaging_id,
          }));
        if (pending.length === 0) return;
        // Write-through: `upsert_product_identifier` is the only sanctioned
        // write seam. It enforces the enrollment invariants (packaging
        // ownership, one primary per product, cross-product code clash)
        // atomically — a direct insert can satisfy the unique index and
        // still leave the identity model inconsistent.
        for (const row of pending) {
          const failure = await writeIdentifier({
            businessId: row.business_id,
            productId: row.product_id,
            code: row.code,
            kind: row.kind,
            packagingId: row.packaging_id,
            isPrimary: row.is_primary,
          });
          if (failure) {
            toast({ title: "Barcode not saved", description: failure, variant: "destructive" });
          }
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
            packaging_id: null,
            _dirty: true,
          },
        ];
      });
    };

    /**
     * Persist a single row.
     *
     * Two invariants (see plan "Barcode edit on phone saves only one
     * character"):
     *  1. Reads the LIVE row from `rowsRef`, never a render-time snapshot,
     *     so a save can't resurrect an older code.
     *  2. Sequence-guarded per row: only the newest issued save for a row is
     *     allowed to report/settle, so a stale in-flight write (e.g. an
     *     intermediate one-character value) can never win the race and
     *     overwrite the full code.
     */
    const persistRow = async (idx: number, override?: Partial<IdentifierRow>) => {
      const live = rowsRef.current[idx];
      if (!live) return;
      const merged = { ...live, ...override };
      const code = merged.code.trim();
      if (!merged.id || !productId || !code) return;

      const key = merged.id;
      const structuralOverride =
        !!override &&
        (override.kind !== undefined ||
          override.packaging_id !== undefined ||
          override.is_primary !== undefined);
      if (!structuralOverride && lastSavedRef.current.get(key) === code) return;

      const seq = (writeSeqRef.current.get(key) ?? 0) + 1;
      writeSeqRef.current.set(key, seq);

      const failure = await writeIdentifier({
        businessId,
        productId,
        code,
        kind: merged.kind,
        packagingId: merged.packaging_id,
        isPrimary: merged.is_primary,
        identifierId: merged.id,
      });

      // A newer save for this row was issued while we were in flight —
      // discard this outcome entirely.
      if (writeSeqRef.current.get(key) !== seq) return;

      if (failure) {
        toast({ title: "Save failed", description: failure, variant: "destructive" });
        return;
      }
      lastSavedRef.current.set(key, code);
      setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, _dirty: false } : r)));
    };

    /**
     * Local-only state update. Typing NEVER writes to the server — the code
     * is persisted on blur, on a confirmed scan, or on form save. Structural
     * changes (kind / packaging / primary) are discrete and persist at once.
     */
    const updateRow = (idx: number, patch: Partial<IdentifierRow>) => {
      const target = rowsRef.current[idx];
      if (!target) return;
      setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch, _dirty: true } : r)));
      const structural = patch.code === undefined;
      if (structural && target.id && productId) {
        void persistRow(idx, patch);
      }
    };


    const setPrimary = async (idx: number) => {
      const target = rowsRef.current[idx];
      if (!target) return;
      setRows((prev) => prev.map((r, i) => ({ ...r, is_primary: i === idx })));
      if (productId && target.id) {
        // The primary flip is atomic inside the service — no demote/promote
        // window where a product has zero (or two) primary codes. Routed
        // through `persistRow` so it shares the live-state read and the
        // per-row write-ordering guard.
        await persistRow(idx, { is_primary: true });
      }
    };

    const deleteRow = async (idx: number) => {
      const target = rowsRef.current[idx];
      if (!target) return;
      setRows((prev) => prev.filter((_, i) => i !== idx));
      if (target.id) {
        // Retire, never hard-delete: a printed label stays explainable
        // ("this code was retired") instead of resolving as unknown.
        const failure = await retireIdentifier({
          businessId,
          identifierId: target.id,
          status: "archived",
        });
        if (failure) {
          toast({
            title: "Could not remove barcode",
            description: failure,
            variant: "destructive",
          });
        }
      }
    };

    // ---------- Camera scan-to-add ----------
    // The engine ladder (BarcodeDetector → ZXing), stream lifecycle, torch and
    // repeat-dedupe live once in `useCameraDecoder` — see
    // src/test/architecture/scanner-single-camera-engine.test.ts.
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
      },
      [rows],
    );

    const { error: scanError, torchAvailable, torchOn, toggleTorch } = useCameraDecoder({
      enabled: scanOpen,
      videoRef,
      onDecode: handleDecoded,
      stopOnFirst: true,
    });

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
            {torchAvailable && (
              <div className="flex justify-end p-1">
                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-white" onClick={toggleTorch}>
                  {torchOn ? "Torch off" : "Torch on"}
                </Button>
              </div>
            )}
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
                    onBlur={() => { void persistRow(idx); }}
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
                {packagingLevels.length > 0 && (
                  <Select
                    value={row.packaging_id ?? "__base__"}
                    onValueChange={(v) =>
                      updateRow(idx, { packaging_id: v === "__base__" ? null : v })
                    }
                  >
                    <SelectTrigger className="h-8 flex-1 sm:flex-none sm:w-[150px] text-xs min-w-0">
                      <SelectValue placeholder="Level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__base__" className="text-xs">
                        Base unit
                      </SelectItem>
                      {packagingLevels.map((lvl) => (
                        <SelectItem key={lvl.id} value={lvl.id} className="text-xs">
                          {lvl.name} × {lvl.qty_in_base_uom}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
