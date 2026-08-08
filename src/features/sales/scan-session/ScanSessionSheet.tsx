/**
 * ScanSessionSheet — the handheld Scan Session for Sales.
 *
 * The problem it solves: on a phone the camera IS the input device, but the
 * old flow was a focus-gated text field plus a viewfinder that closed after
 * one decode and told the operator nothing about what was captured. Picking
 * 30 items meant 30 open/close cycles with no running tally and no way to
 * see or fix a mistake without leaving the camera.
 *
 * This surface keeps the camera live, shows the resolved product for every
 * scan, keeps a running line/unit/value tally with per-line quantity
 * controls and undo, queues codes that don't resolve instead of dropping
 * them, and commits the reviewed list to the invoice draft in one action.
 *
 * Architecture (ADR 0107 / ADR 0018 invariants preserved):
 *  - Decoding goes through `useCameraDecoder` — the single camera engine.
 *  - Wedge/companion scans still arrive via `scanRouter`: the session
 *    registers ONE target above the Sales workspace target, so exactly one
 *    consumer handles a scan (no double-apply).
 *  - Resolution goes through `useResolveBarcode` (the shared identity seam).
 *  - All state lives in the pure `scanSessionReducer`.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  X,
  Zap,
  ZapOff,
  Loader2,
  Check,
  TriangleAlert,
  Minus,
  Plus,
  Undo2,
  Trash2,
  ScanLine,
  PackageSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useCameraDecoder } from "@/services/scanner/camera/useCameraDecoder";
import { useScanTarget } from "@/hooks/pos/useScanTarget";
import { useResolveBarcode } from "@/hooks/scanner";
import { describeIdentityOutcome } from "@/features/products/identity/identityOutcome";
import { scanFeedbackBus } from "@/services/scanner";
import { beepForScan } from "@/services/scanner/scanBeep";
import { feedbackTones } from "@/services/scanner/feedbackTones";
import {
  deserializeScanSession,
  emptyScanSession,
  scanSessionCommitEntries,
  scanSessionReducer,
  scanSessionStorageKey,
  scanSessionTotals,
  serializeScanSession,
} from "./scanSessionStore";

interface Props {
  open: boolean;
  onClose: () => void;
  businessId?: string;
  branchId?: string | null;
  userId?: string | null;
  formatCurrency: (n: number) => string;
  /** Hand the reviewed picking list to the host document. */
  onCommit: (entries: { resolved: import("@/hooks/scanner").ResolvedScan; quantity: number }[]) => void;
}

type Flash =
  | { kind: "added" | "merged"; name: string; qty: number; at: number }
  | { kind: "unknown" | "failed"; name: string; qty: 0; at: number }
  | null;

function haptic(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported — tones already carry the signal */
  }
}

export function ScanSessionSheet({
  open,
  onClose,
  businessId,
  branchId = null,
  userId,
  formatCurrency,
  onCommit,
}: Props) {
  const [state, dispatch] = useReducer(scanSessionReducer, emptyScanSession);
  const [flash, setFlash] = useState<Flash>(null);
  const [resolving, setResolving] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { resolveTagged } = useResolveBarcode(businessId, branchId);
  const storageKey = useMemo(() => scanSessionStorageKey(businessId, userId), [businessId, userId]);
  const hydratedRef = useRef(false);

  // ---- Session durability: a picked cart must survive a backgrounded tab,
  // a dropped connection, or an accidental navigation.
  useEffect(() => {
    if (!open || hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const restored = deserializeScanSession(localStorage.getItem(storageKey));
      if (restored) dispatch({ type: "hydrate", ...restored });
    } catch {
      /* ignore */
    }
  }, [open, storageKey]);

  useEffect(() => {
    if (!open) return;
    try {
      if (state.lines.length === 0 && state.unknown.length === 0) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, serializeScanSession(state));
      }
    } catch {
      /* quota / private mode — the session still works in memory */
    }
  }, [open, state, storageKey]);

  const totals = useMemo(() => scanSessionTotals(state), [state]);

  const handleCode = useCallback(
    async (raw: string) => {
      const code = (raw || "").trim();
      if (!code) return;
      setResolving((n) => n + 1);
      try {
        const result = await resolveTagged(code);
        if (result.kind === "hit") {
          const already = state.lines.some((l) => l.productId === result.row.productId);
          dispatch({ type: "resolved", resolved: result.row });
          setFlash({
            kind: already ? "merged" : "added",
            name: result.row.name,
            qty: result.row.scanQuantity,
            at: Date.now(),
          });
          beepForScan(code, "ok");
          haptic(already ? [18, 40, 18] : 28);
          scanFeedbackBus.emit({
            kind: "ok",
            raw: code,
            source: "field",
            workflow: "quantity",
            fieldLabel: "Scan session",
            detail: result.row.name,
          });
          return;
        }
        if (result.kind === "miss") {
          const outcome = describeIdentityOutcome({
            status: result.status,
            code,
            matchCount: result.matchCount,
            productName: result.productName,
          });
          dispatch({ type: "unknown", code, reason: outcome.title });
          setFlash({ kind: "unknown", name: outcome.title, qty: 0, at: Date.now() });
          beepForScan(code, "invalid");
          haptic([60, 50, 60]);
          scanFeedbackBus.emit({
            kind: "unknown",
            raw: code,
            source: "field",
            workflow: "quantity",
            fieldLabel: "Scan session",
            detail: outcome.title,
          });
          return;
        }
        const cause = [result.code, result.err.message].filter(Boolean).join(" · ");
        dispatch({ type: "unknown", code, reason: `Lookup failed — ${cause}` });
        setFlash({ kind: "failed", name: "Lookup failed", qty: 0, at: Date.now() });
        beepForScan(code, "invalid");
        haptic([80, 60, 80]);
        scanFeedbackBus.emit({
          kind: "error",
          raw: code,
          source: "field",
          workflow: "quantity",
          fieldLabel: "Scan session",
          detail: cause,
        });
      } finally {
        setResolving((n) => Math.max(0, n - 1));
      }
    },
    [resolveTagged, state.lines],
  );

  // Stable router registration (see SalesScanContext: a changing onScan
  // identity re-registers the target and can drop a scan mid-swap).
  const handleCodeRef = useRef(handleCode);
  useEffect(() => {
    handleCodeRef.current = handleCode;
  }, [handleCode]);
  const routerOnScan = useCallback((e: { code: string }) => {
    void handleCodeRef.current(e.code);
  }, []);

  // Sits above the Sales workspace target (priority 5) so exactly one
  // consumer handles each scan while the session is open.
  useScanTarget({
    active: open,
    priority: 40,
    label: "ScanSessionSheet",
    workflow: "count",
    allowRepeats: true,
    onScan: routerOnScan,
  });

  const onDecode = useCallback((raw: string) => {
    void handleCodeRef.current(raw);
  }, []);

  const { scanning, error, torchAvailable, torchOn, toggleTorch } = useCameraDecoder({
    enabled: open,
    videoRef,
    onDecode,
    dedupeMs: 700,
  });

  useEffect(() => {
    if (!open) return;
    feedbackTones.unlock();
  }, [open]);

  // Fade the hit card after a moment so the viewfinder stays usable.
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2600);
    return () => window.clearTimeout(t);
  }, [flash]);

  const commit = useCallback(() => {
    const entries = scanSessionCommitEntries(state);
    if (entries.length === 0) return;
    onCommit(entries);
    dispatch({ type: "clear" });
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    onClose();
  }, [onClose, onCommit, state, storageKey]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[130] flex flex-col bg-neutral-950 text-neutral-50">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ScanLine className="h-5 w-5 shrink-0 text-emerald-400" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Scan session</div>
            <div className="truncate text-[11px] text-neutral-400">
              {scanning ? "Camera live — keep scanning" : "Starting camera…"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {resolving > 0 && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />}
          {torchAvailable && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTorch}
              aria-label={torchOn ? "Turn torch off" : "Turn torch on"}
              className="text-neutral-200 hover:bg-white/10"
            >
              {torchOn ? <Zap className="h-5 w-5" /> : <ZapOff className="h-5 w-5" />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close scan session"
            onClick={onClose}
            className="text-neutral-200 hover:bg-white/10"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Viewfinder */}
      <div className="relative h-[38vh] min-h-[200px] shrink-0 overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={cn(
              "h-28 w-[78%] max-w-sm rounded-xl border-2 transition-colors",
              flash?.kind === "added" || flash?.kind === "merged"
                ? "border-emerald-400"
                : flash
                  ? "border-red-400"
                  : "border-white/70",
            )}
          />
        </div>
        {error && (
          <div className="absolute inset-x-3 bottom-3 rounded-md bg-red-950/90 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}
        {/* Last-hit card — the operator's confirmation of WHAT was scanned. */}
        {flash && (
          <div
            className={cn(
              "absolute inset-x-3 bottom-3 rounded-xl border px-3 py-2 shadow-lg backdrop-blur",
              flash.kind === "added" || flash.kind === "merged"
                ? "border-emerald-400/40 bg-emerald-950/80"
                : "border-red-400/40 bg-red-950/80",
            )}
          >
            <div className="flex items-center gap-2">
              {flash.kind === "added" || flash.kind === "merged" ? (
                <Check className="h-4 w-4 shrink-0 text-emerald-300" />
              ) : (
                <TriangleAlert className="h-4 w-4 shrink-0 text-red-300" />
              )}
              <span className="truncate text-sm font-medium">{flash.name}</span>
              {flash.qty > 0 && (
                <Badge className="ml-auto shrink-0 bg-emerald-500/20 text-emerald-200">
                  +{flash.qty}
                </Badge>
              )}
            </div>
            {flash.kind === "merged" && (
              <div className="mt-0.5 text-[11px] text-emerald-200/80">
                Already on the list — quantity increased
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tally */}
      <div className="flex items-center justify-between border-y border-white/10 px-3 py-2 text-xs">
        <span className="font-medium">
          {totals.lineCount} {totals.lineCount === 1 ? "line" : "lines"} ·{" "}
          {Number(totals.unitCount.toFixed(3))} units
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={state.past.length === 0}
            onClick={() => dispatch({ type: "undo" })}
            className="h-7 gap-1 px-2 text-neutral-200 hover:bg-white/10"
          >
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={totals.lineCount === 0 && state.unknown.length === 0}
            onClick={() => dispatch({ type: "clear" })}
            className="h-7 gap-1 px-2 text-neutral-400 hover:bg-white/10"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.unknown.length > 0 && (
          <div className="border-b border-amber-500/20 bg-amber-950/30 px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
              <PackageSearch className="h-3.5 w-3.5" />
              Not recognised — kept so nothing is lost
            </div>
            <ul className="space-y-1">
              {state.unknown.map((u) => (
                <li key={u.code} className="flex items-center gap-2 text-xs text-amber-100/90">
                  <span className="truncate font-mono">{u.code}</span>
                  {u.count > 1 && <span className="shrink-0 text-amber-300/70">×{u.count}</span>}
                  <span className="ml-auto shrink-0 truncate pl-2 text-[11px] text-amber-200/70">
                    {u.reason}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Dismiss ${u.code}`}
                    onClick={() => dispatch({ type: "dismissUnknown", code: u.code })}
                    className="h-6 w-6 shrink-0 text-amber-200 hover:bg-white/10"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {state.lines.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-neutral-400">
            Point the camera at a barcode. Every hit lands here with its quantity —
            you can fix anything before adding it to the invoice.
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {state.lines.map((line) => (
              <li key={line.productId} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{line.name}</div>
                  <div className="truncate text-[11px] text-neutral-400">
                    {line.sku ?? "no SKU"}
                    {line.levelLabel ? ` · ${line.levelLabel}` : ""}
                    {line.scans > 1 ? ` · ${line.scans} scans` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Decrease ${line.name}`}
                    onClick={() =>
                      dispatch({
                        type: "setQuantity",
                        productId: line.productId,
                        quantity: line.quantity - 1,
                      })
                    }
                    className="h-7 w-7 text-neutral-200 hover:bg-white/10"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <span className="w-10 text-center text-sm font-semibold tabular-nums">
                    {Number(line.quantity.toFixed(3))}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Increase ${line.name}`}
                    onClick={() =>
                      dispatch({
                        type: "setQuantity",
                        productId: line.productId,
                        quantity: line.quantity + 1,
                      })
                    }
                    className="h-7 w-7 text-neutral-200 hover:bg-white/10"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <span className="w-20 text-right text-xs text-neutral-300 tabular-nums">
                    {formatCurrency(line.quantity * line.unitPrice)}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${line.name}`}
                    onClick={() => dispatch({ type: "remove", productId: line.productId })}
                    className="h-7 w-7 text-neutral-500 hover:bg-white/10"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-white/10 px-3 pb-5 pt-2">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-neutral-400">Scanned value</span>
          <span className="font-semibold tabular-nums">{formatCurrency(totals.value)}</span>
        </div>
        <Button
          className="h-11 w-full text-base"
          disabled={totals.lineCount === 0}
          onClick={commit}
        >
          Add {totals.lineCount || ""} {totals.lineCount === 1 ? "line" : "lines"} to invoice
        </Button>
      </div>
    </div>
  );
}
