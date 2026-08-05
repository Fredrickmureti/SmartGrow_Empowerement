/**
 * BinScanField — the operator-side location scan control.
 *
 * Every RF surface that says "scan the bin" mounts this. It exists because
 * a string compare against `location.code` is not a location scan: the
 * physical label may carry a barcode that differs from the code, the same
 * code can exist in two warehouses, and an ambiguous scan must block rather
 * than be guessed. All of that lives once, here, on top of
 * `resolve_location_identity`.
 *
 * It also registers the correct WMS scan intent, so a wedge scanner, a
 * Bluetooth ring scanner, a rugged terminal or a paired phone all feed the
 * field without the operator having to focus an input with gloves on.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, ScanLine, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useResolveLocationIdentity, type ResolvedLocation } from "./useResolveLocationIdentity";
import { useWmsScanIntent, type WmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";
import { useScanFeedback } from "@/features/warehouse/scanning/useScanFeedback";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";
import { classifyScanToken, describeTokenMismatch } from "@/lib/scan/classifyScanToken";

export type BinScanState = "idle" | "checking" | "confirmed" | "mismatch" | "unknown";

interface Props {
  label: string;
  intent: WmsScanIntent;
  /** The location the task expects. Scanning anything else is refused. */
  expectedLocationId: string | null;
  expectedCode?: string | null;
  warehouseId?: string | null;
  disabled?: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  /**
   * Put-away deviation: the operator is allowed to store the goods in a
   * different valid position than the suggested one. The scan still has to
   * resolve to a real position; it is reported through `onResolvedLocation`
   * and flagged via `onDeviationChange` so the caller can demand a reason.
   */
  allowDeviation?: boolean;
  onDeviationChange?: (deviated: boolean) => void;
  /**
   * Emits the resolved position (or null when the scan fails). Surfaces with
   * no pre-assigned bin — a cycle count, say — use this instead of the
   * expected-id compare.
   */
  onResolvedLocation?: (location: ResolvedLocation | null) => void;
}

export function BinScanField({
  label,
  intent,
  expectedLocationId,
  expectedCode,
  warehouseId,
  disabled,
  onConfirmedChange,
  allowDeviation,
  onDeviationChange,
  onResolvedLocation,
}: Props) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<BinScanState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const { resolve } = useResolveLocationIdentity(warehouseId ?? null);
  const feedback = useScanFeedback();

  const check = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setState("idle");
        setMessage(null);
        onConfirmedChange(false);
        onResolvedLocation?.(null);
        return;
      }
      // Phase 7 — a product or pallet label scanned at a bin prompt is a
      // wrong-kind scan, not an unknown position.
      const mismatch = describeTokenMismatch(classifyScanToken(trimmed), "location");
      if (mismatch) {
        setState("unknown");
        setMessage(mismatch);
        feedback.error();
        onConfirmedChange(false);
        onDeviationChange?.(false);
        onResolvedLocation?.(null);
        return;
      }
      setState("checking");
      const result = await resolve(trimmed);
      if (result.status !== "ok" || !result.location) {
        setState("unknown");
        setMessage(result.message ?? "That label is not a known position.");
        feedback.error();
        onConfirmedChange(false);
        onDeviationChange?.(false);
        onResolvedLocation?.(null);
        return;
      }
      if (expectedLocationId && result.location.location_id !== expectedLocationId) {
        if (allowDeviation) {
          setState("confirmed");
          setMessage(
            `${result.location.code} confirmed — differs from ${expectedCode ?? "the suggested bin"}. A reason is required.`,
          );
          feedback.success();
          onConfirmedChange(true);
          onDeviationChange?.(true);
          onResolvedLocation?.(result.location);
          return;
        }
        setState("mismatch");
        setMessage(`Wrong position — this job needs ${expectedCode ?? "the assigned bin"}.`);
        feedback.error();
        onConfirmedChange(false);
        onDeviationChange?.(false);
        onResolvedLocation?.(null);
        return;
      }
      setState("confirmed");
      setMessage(`${result.location.code} confirmed`);
      feedback.success();
      onConfirmedChange(true);
      onDeviationChange?.(false);
      onResolvedLocation?.(result.location);
    },
    [
      resolve,
      expectedLocationId,
      expectedCode,
      feedback,
      allowDeviation,
      onConfirmedChange,
      onDeviationChange,
      onResolvedLocation,
    ],
  );

  useWmsScanIntent({
    intent,
    label: `wms:${intent}:field`,
    enabled: !disabled,
    onScan: ({ resolveCode }) => {
      setValue(resolveCode);
      void check(resolveCode);
    },
  });

  useEffect(() => {
    setValue("");
    setState("idle");
    setMessage(null);
    onConfirmedChange(false);
    // Reset whenever the expected position changes (next task).
  }, [expectedLocationId, onConfirmedChange]);

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <ScanLine className="h-4 w-4" /> {label}
        {/* Handheld mode: scan the bin label with this device's camera. */}
        <ScanCameraButton label={label} disabled={disabled} className="ml-auto" />
      </Label>
      <Input
        className={cn(
          "h-12 font-mono text-base",
          state === "confirmed" && "border-primary",
          (state === "mismatch" || state === "unknown") && "border-destructive",
        )}
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        placeholder={expectedCode ? `Scan ${expectedCode}` : "Scan the position label"}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void check(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void check(value);
          }
        }}
      />
      {message && (
        <p
          className={cn(
            "flex items-center gap-1.5 text-xs",
            state === "confirmed" ? "text-primary" : "text-destructive",
          )}
        >
          {state === "confirmed" ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <TriangleAlert className="h-3.5 w-3.5" />
          )}
          {message}
        </p>
      )}
      <feedback.Flash />
    </div>
  );
}
