/**
 * ProductScanField — the operator-side product scan control for RF surfaces.
 *
 * Counterpart to `BinScanField`. A typed SKU compared with `toLowerCase()` is
 * not a product scan: the label may carry a GTIN, a case barcode, or a GS1
 * payload with lot/expiry, and an ambiguous identifier must block the line
 * rather than be guessed. All of that lives once in `useWmsIdentityGate`
 * (ADR-0017 / ADR-0071); this component is its RF-shaped surface.
 *
 * It registers the matching WMS scan intent so wedge, Bluetooth ring, rugged
 * terminal and paired-phone scans feed the field without focusing an input.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, ScanBarcode, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useWmsIdentityGate, describeLevel, type GatedScan } from "./useWmsIdentityGate";
import { useWmsScanIntent, type WmsScanIntent } from "./wmsScanIntent";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";

export type ProductScanState = "idle" | "checking" | "confirmed" | "mismatch" | "unknown";

interface Props {
  label: string;
  intent: WmsScanIntent;
  businessId: string | undefined;
  branchId?: string | null;
  /** When set, only this product is accepted (task-driven surfaces). */
  expectedProductId?: string | null;
  expectedSku?: string | null;
  disabled?: boolean;
  /**
   * Optional pre-check run before the product identity gate. Return `true` when
   * the code was consumed by the surface (e.g. a license-plate label scanned
   * into the item field), so it is never reported as an unknown product.
   */
  interceptScan?: (code: string) => Promise<boolean> | boolean;
  /** Emits the gated scan on success, `null` on every failure/reset. */
  onResolved: (scan: GatedScan | null) => void;
}

export function ProductScanField({
  label,
  intent,
  businessId,
  branchId = null,
  expectedProductId,
  expectedSku,
  disabled,
  interceptScan,
  onResolved,
}: Props) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<ProductScanState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const { gate } = useWmsIdentityGate(businessId, branchId);

  const check = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setState("idle");
        setMessage(null);
        onResolved(null);
        return;
      }
      setState("checking");
      if (interceptScan && (await interceptScan(trimmed))) {
        setValue("");
        setState("idle");
        setMessage(null);
        onResolved(null);
        return;
      }
      const scan = await gate({ raw: trimmed, resolveCode: trimmed, workflow: "identity" });
      if (!scan) {
        setState("unknown");
        setMessage("That code is not a known product — the gate blocked the line.");
        onResolved(null);
        return;
      }
      if (expectedProductId && scan.identity.productId !== expectedProductId) {
        setState("mismatch");
        setMessage(`Wrong product — this job needs ${expectedSku ?? "the listed item"}.`);
        onResolved(null);
        return;
      }
      setState("confirmed");
      setMessage(
        `${scan.identity.sku ?? scan.identity.productName} · ${describeLevel(scan.identity)}`,
      );
      onResolved(scan);
    },
    [gate, expectedProductId, expectedSku, onResolved, interceptScan],
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
    onResolved(null);
  }, [expectedProductId, onResolved]);

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <ScanBarcode className="h-4 w-4" /> {label}
        {/* Handheld mode: scan the item label with this device's camera. */}
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
        placeholder={expectedSku ? `Scan ${expectedSku}` : "Scan the item label"}
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
    </div>
  );
}
