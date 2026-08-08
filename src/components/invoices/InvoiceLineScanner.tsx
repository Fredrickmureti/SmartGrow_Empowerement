/**
 * InvoiceLineScanner — scan-first line entry for the Sales / Invoice
 * dialogs. The visible `<BarcodeInputField>` is a manual-entry surface;
 * the real transport for high-velocity scanning is `SalesScanContext`,
 * which owns a long-lived router target at the Sales workspace level.
 *
 * Lifecycle:
 *  - On mount, registers a draft controller in `SalesScanContext`. Every
 *    scan dispatched by the router (paired phone, USB wedge, camera, or
 *    a buffered scan from before the dialog opened) lands here without
 *    requiring the scanner input to be focused.
 *  - On unmount, unregisters — the workspace falls back to "open draft"
 *    behaviour.
 *  - Manual scans typed into the visible field still resolve here via
 *    `onScan`, so the path is unified.
 *
 * Focus management:
 *  - No more `document.querySelector` for refocus. We hold a
 *    `BarcodeInputFieldHandle` ref and refocus the input ONLY if the
 *    active element is `document.body` (operator hasn't intentionally
 *    clicked anything else). Radix Select / Popover / Toast portals
 *    therefore never fight us.
 *  - F2 still focuses the field from anywhere in the dialog.
 *  - Operators are no longer required to keep this input focused —
 *    losing focus does not break continuous scanning.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ScanLine } from "lucide-react";
import {
  BarcodeInputField,
  type BarcodeInputFieldHandle,
} from "@/components/scanner/BarcodeInputField";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";
import { Button } from "@/components/ui/button";
import { scanFeedbackBus } from "@/services/scanner";
import { useResolveBarcode, type ResolvedScan } from "@/hooks/scanner";
import { identityOutcomeLine } from "@/features/products/identity/identityOutcome";
import { useLocalScan } from "@/hooks/scanner/useLocalScan";
import { useSalesScanController } from "@/contexts/SalesScanContext";
import { ScanSessionSheet } from "@/features/sales/scan-session/ScanSessionSheet";
import { useCurrency } from "@/hooks/useCurrency";
import { useAuth } from "@/contexts/AuthContext";

interface Props {
  businessId?: string;
  branchId?: string | null;
  /** Called once per router-confirmed scan that resolves to a product. */
  onResolved: (resolved: ResolvedScan) => void;
  /** Optional ref to the lines-table container — used to decide whether
   *  to steal focus back after a scan. If a cell inside this ref is
   *  focused, refocus is skipped. */
  linesTableRef?: React.RefObject<HTMLElement>;
  /** Disable the entire scanner (e.g. while the dialog is submitting). */
  disabled?: boolean;
  /**
   * Commit handler for a reviewed Scan Session batch. Quantities are
   * authoritative (the operator already reviewed them), so the host
   * applies them as-is instead of following single-scan doc_author rules.
   * When omitted the Scan Session affordance is hidden.
   */
  onSessionCommit?: (
    entries: { resolved: ResolvedScan; quantity: number }[],
  ) => void;
  /** Open the Scan Session immediately (deep link from the Sales chip). */
  openSessionOnMount?: boolean;
}

export function InvoiceLineScanner({
  businessId,
  branchId = null,
  onResolved,
  linesTableRef,
  disabled,
  onSessionCommit,
  openSessionOnMount,
}: Props) {
  const { resolveTagged } = useResolveBarcode(businessId, branchId);
  const { handheld } = useLocalScan();
  const { formatCurrency } = useCurrency();
  const { user } = useAuth();
  const sessionEnabled = !!onSessionCommit;
  const [sessionOpen, setSessionOpen] = useState(false);
  useEffect(() => {
    if (openSessionOnMount && sessionEnabled) setSessionOpen(true);
  }, [openSessionOnMount, sessionEnabled]);
  const inputRef = useRef<BarcodeInputFieldHandle | null>(null);
  const [scanCode, setScanCode] = useState("");
  const [resolving, setResolving] = useState(false);
  const [lastFlash, setLastFlash] = useState<{ kind: "ok" | "miss" | "err"; text: string } | null>(
    null,
  );

  // Register this dialog as the active scan controller. Every scan
  // routed through SalesScanContext now lands here, regardless of which
  // input (if any) is focused. This is the single fix that makes
  // continuous scanning work — input focus stops being on the hot path.
  useSalesScanController(
    useCallback(
      (resolved: ResolvedScan) => {
        onResolved(resolved);
        setLastFlash({ kind: "ok", text: `+${resolved.scanQuantity} ${resolved.name}` });
        window.setTimeout(() => setLastFlash(null), 1800);
      },
      [onResolved],
    ),
  );

  const safeRefocus = useCallback(() => {
    // Only refocus if the operator hasn't clicked into something else.
    // Specifically: never steal focus from a cell inside the lines table,
    // never steal from a Radix portal (Select / Toast / Dialog), only
    // recover when the active element is the page body.
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    if (active !== document.body) return;
    if (linesTableRef?.current?.contains(active)) return;
    inputRef.current?.focus();
  }, [linesTableRef]);

  // Manual entry path — operator typed a code into the visible field
  // and pressed Enter (BarcodeInputField fires onScan from the router
  // when a wedge / phone sends one; for manually typed values we go
  // through resolveTagged here so the math is identical).
  const handleManualScan = useCallback(
    async (code: string) => {
      const norm = code.trim();
      if (!norm || !businessId) return;
      setScanCode("");
      setResolving(true);
      try {
        const result = await resolveTagged(norm);
        if (result.kind === "hit") {
          onResolved(result.row);
          setLastFlash({ kind: "ok", text: `+${result.row.scanQuantity} ${result.row.name}` });
          scanFeedbackBus.emit({
            kind: "ok",
            raw: norm,
            source: "field",
            workflow: "quantity",
            fieldLabel: "Invoice line",
          });
        } else if (result.kind === "miss") {
          setLastFlash({
            kind: "miss",
            text: identityOutcomeLine({
              status: result.status,
              code: norm,
              matchCount: result.matchCount,
              productName: result.productName,
            }),
          });
          scanFeedbackBus.emit({
            kind: "unknown",
            raw: norm,
            source: "field",
            workflow: "quantity",
            fieldLabel: "Invoice line",
          });
        } else {
          setLastFlash({ kind: "err", text: "Network blip — try again" });
          scanFeedbackBus.emit({
            kind: "error",
            raw: norm,
            source: "field",
            workflow: "quantity",
            fieldLabel: "Invoice line",
          });
        }
      } finally {
        setResolving(false);
        window.setTimeout(() => setLastFlash(null), 1800);
        // Use rAF so we run after React commits the post-scan render —
        // avoids racing with the row that just appeared in the table.
        requestAnimationFrame(safeRefocus);
      }
    },
    [businessId, onResolved, resolveTagged, safeRefocus],
  );

  // F2 — focus the scanner field. Scoped to the dialog container that
  // owns this scanner so a stacked dialog (e.g. PaymentDialog above) does
  // not redirect F2 into the now-hidden invoice scanner.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = containerRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    const target: HTMLElement | Document = root ?? document;
    const onKey = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "F2") {
        ke.preventDefault();
        inputRef.current?.focus();
      }
    };
    target.addEventListener("keydown", onKey as EventListener);
    return () => target.removeEventListener("keydown", onKey as EventListener);
  }, []);

  if (!businessId) return null;

  const flashClass =
    lastFlash?.kind === "miss"
      ? "text-destructive"
      : lastFlash?.kind === "err"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";

  return (
    <div
      ref={containerRef}
      data-invoice-line-scanner="true"
      className="rounded-lg border bg-muted/30 p-3 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">
          {handheld
            ? "Tap Scan products for a live camera session — every hit shows up with its quantity"
            : <>Scan to add a line · press <kbd className="rounded border px-1 text-[10px]">F2</kbd> to refocus · scanning works even when this input is not focused</>}
        </div>
        {!handheld && (
          <ScannerPairingButton
            businessId={businessId}
            branchId={branchId}
            label="Invoice"
          />
        )}
      </div>
      {handheld && (
        <div className="flex items-center gap-2">
          {sessionEnabled ? (
            <Button
              type="button"
              onClick={() => setSessionOpen(true)}
              disabled={disabled}
              className="h-11 flex-1 gap-2 text-base"
            >
              <ScanLine className="h-4 w-4" />
              Scan products
            </Button>
          ) : (
            <ScanCameraButton
              withText
              continuous
              label="Scan product"
              disabled={disabled}
              className="flex-1 h-11"
            />
          )}
        </div>
      )}
      <BarcodeInputField
        ref={inputRef}
        value={scanCode}
        onChange={setScanCode}
        onScan={(code) => {
          void handleManualScan(code);
        }}
        businessId={businessId}
        branchId={branchId}
        allowRepeats
        workflow="quantity"
        fieldLabel="Invoice line"
        placeholder={
          handheld
            ? "Or type a barcode / SKU"
            : "Scan a product barcode — same code repeats = qty +1"
        }
        disabled={disabled}
      />
      <div className="flex items-center gap-2 text-xs min-h-[1.25rem]">
        {resolving && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> resolving…
          </span>
        )}
        {!resolving && lastFlash && <span className={flashClass}>{lastFlash.text}</span>}
      </div>
      {sessionEnabled && (
        <ScanSessionSheet
          open={sessionOpen}
          onClose={() => setSessionOpen(false)}
          businessId={businessId}
          branchId={branchId}
          userId={user?.id ?? null}
          formatCurrency={formatCurrency}
          onCommit={(entries) => onSessionCommit?.(entries)}
        />
      )}
    </div>
  );
}
