/**
 * BarcodeInputField — reusable scanner-aware barcode input.
 *
 * Drop-in replacement for any text input that should accept a barcode:
 *   - registers itself with `scanRouter` while focused so phone/camera/
 *     keyboard scans land here regardless of source
 *   - shows a small "Scan ready" chip when connected
 *   - optional duplicate check via `resolve_product_identity`
 *   - optional `nextFocusRef` to auto-advance after a scan
 *
 * Always import the global scanner kernel ONCE near the app root via
 * `useScanCapture()` — without it the keyboard-wedge source is silent.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, ScanLine, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useScanTarget } from "@/hooks/pos/useScanTarget";
import { scanFeedbackBus } from "@/services/scanner";
import { useWorkspaceScanner } from "@/contexts/ScannerWorkspaceContext";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (next: string) => void;
  /** Active business — required if duplicate check is enabled. */
  businessId?: string;
  /**
   * Branch scope for the uniqueness check. Defaults to `null` (business-wide).
   * For multi-branch tenants where a barcode may legitimately appear in two
   * branches, pass the active branch to scope the warning correctly.
   */
  branchId?: string | null;
  /** When set, after a scan the field calls `next.focus()`. */
  nextFocusRef?: React.RefObject<HTMLElement>;
  /** Whether a phone scanner is connected (for the status chip). */
  scannerConnected?: boolean;
  /** Run a server-side duplicate check on every scan/blur. */
  checkUniqueness?: boolean;
  /** Excluded product id (when editing) to avoid self-match. */
  excludeProductId?: string;
  /**
   * Allow the same code to fire repeatedly without the cross-source 250 ms
   * dedupe. Set true on counting / receiving fields where scanning the same
   * SKU twice means "count 2".
   */
  allowRepeats?: boolean;
  /**
   * Human label mirrored to the phone status band as the workflow chip
   * detail (e.g. "Bin A12", "SKU"). Falls back to placeholder/aria-label.
   */
  fieldLabel?: string;
  /**
   * Workflow override. Defaults to "identity" — every <BarcodeInputField>
   * captures an identity (SKU/serial). Counting/receiving wrappers can
   * pass "count" or "receive" so the phone chip reflects accurately.
   */
  workflow?: "identity" | "quantity" | "count" | "receive";
  /**
   * Router-confirmed scan callback. Fires ONLY when `scanRouter` dispatches
   * a real scan event to this field (paired phone, USB wedge, camera,
   * native SDK). Does NOT fire on manual typing or paste.
   *
   * Prefer this over `onChange + length>=4` heuristics — those produce
   * spurious scans whenever the user types a 4-character search term.
   */
  onScan?: (code: string) => void;
}

export interface BarcodeInputFieldHandle {
  focus: () => void;
}

export const BarcodeInputField = forwardRef<BarcodeInputFieldHandle, Props>(function BarcodeInputField(
  {
    value,
    onChange,
    businessId,
    branchId = null,
    nextFocusRef,
    scannerConnected,
    checkUniqueness,
    excludeProductId,
    allowRepeats,
    fieldLabel,
    workflow = "identity",
    onScan,
    className,
    placeholder = "Scan or type a barcode",
    ...rest
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  // The local viewfinder steals DOM focus; keep this field registered with
  // scanRouter for as long as it is open so the decode lands here.
  const [cameraOpen, setCameraOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [duplicate, setDuplicate] = useState<{ name: string } | null>(null);
  // Scanner Scope filter — in `scoped` mode this drops POS-register
  // scans before they can hijack a workspace field. No-op in Ambient.
  const { acceptsTopic } = useWorkspaceScanner();

  // Sequence id so a stale duplicate-check response can never overwrite
  // the result of a later scan. Paired with a 200 ms debounce so rapid
  // onboarding (gun at 5 SKUs/sec) doesn't fire one RPC per scan.
  const checkSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);


  const runDuplicateCheck = (code: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!checkUniqueness || !businessId || !code.trim()) {
      setDuplicate(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const seq = ++checkSeqRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        // ADR-0110: single authoritative resolver seam.
        const { data } = await supabase.rpc("resolve_product_identity" as any, {
          p_business_id: businessId,
          p_branch_id: branchId,
          p_code: code.trim(),
        } as any);
        // Drop the result if a newer check has started since we fired.
        if (seq !== checkSeqRef.current) return;
        const row = Array.isArray(data) && data.length > 0 ? (data[0] as any) : null;
        const taken = row && (row.status === "resolved" || row.status === "ambiguous");
        if (taken && row.product_id !== excludeProductId) {
          setDuplicate({ name: (row.product_name ?? "another product") as string });
        } else {
          setDuplicate(null);
        }
      } catch {
        if (seq === checkSeqRef.current) setDuplicate(null);
      } finally {
        if (seq === checkSeqRef.current) setChecking(false);
      }
    }, 200);
  };

  // Cancel any pending RPC on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      checkSeqRef.current++;
    };
  }, []);

  // Resolve the human label for the workflow chip: explicit prop wins,
  // then aria-label, then placeholder. Trimmed + capped so it survives
  // the broadcast payload's 120-char cap.
  const resolvedFieldLabel = (() => {
    const raw = (fieldLabel
      ?? (rest as { "aria-label"?: string })["aria-label"]
      ?? (typeof placeholder === "string" ? placeholder : ""))?.toString().trim();
    if (!raw) return undefined;
    return raw.length > 120 ? raw.slice(0, 117) + "…" : raw;
  })();

  useScanTarget({
    active: focused || cameraOpen,
    label: "BarcodeInputField",
    workflow,
    allowRepeats,
    acceptsTopic,
    onScan: (e) => {
      onChange(e.code);
      scanFeedbackBus.emit({
        kind: "ok",
        raw: e.code,
        source: "field",
        workflow,
        fieldLabel: resolvedFieldLabel,
      });
      runDuplicateCheck(e.code);
      onScan?.(e.code);
      if (nextFocusRef?.current) {
        setTimeout(() => nextFocusRef.current?.focus(), 0);
      }
    },
  });


  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setDuplicate(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            runDuplicateCheck(value);
          }}
          placeholder={placeholder}
          className={cn("pr-32", className)}
          autoComplete="off"
          spellCheck={false}
          {...rest}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {checking && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {/* Handheld mode only — the ERP is running on the scanning device. */}
          <ScanCameraButton
            label={resolvedFieldLabel ?? "Scan barcode"}
            continuous={workflow === "count" || workflow === "receive"}
            onBeforeOpen={() => {
              setCameraOpen(true);
              inputRef.current?.focus();
            }}
            onClose={() => setCameraOpen(false)}
            disabled={rest.disabled}
          />
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] gap-1 px-1.5 py-0",
              scannerConnected
                ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                : focused
                  ? "border-primary/40 text-primary"
                  : "text-muted-foreground",
            )}
          >
            <ScanLine className="h-3 w-3" />
            {scannerConnected ? "Phone ready" : focused ? "Scan ready" : "Scanner"}
          </Badge>
        </div>

      </div>
      {duplicate && (
        <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" />
          Already used by <span className="font-medium">{duplicate.name}</span>
        </div>
      )}
      {!duplicate && value && checkUniqueness && !checking && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Unique
        </div>
      )}
    </div>
  );
});
