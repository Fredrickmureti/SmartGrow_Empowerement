/**
 * EntityScanField — the third member of the RF scan trio, alongside
 * `BinScanField` (positions) and `ProductScanField` (products).
 *
 * It serves every handling-unit and document prompt: carton LPNs at the
 * loading bay, LPNs at QC, trailers in the yard, gate passes at the
 * gatehouse. Before this existed, those prompts were plain `<Input>`
 * elements, which meant no wedge/ring/camera capture, no wrong-kind
 * refusal, and no shared audio/haptic feedback — the operator got a
 * red toast at best.
 *
 * Admission is governed by `gateEntityToken`; *resolution* stays with the
 * caller through `onResolve`, because only the screen knows which cartons
 * belong to this manifest or which trailers are on this yard.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, ScanBarcode, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useWmsScanIntent, type WmsScanIntent } from "./wmsScanIntent";
import { useScanFeedback } from "./useScanFeedback";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";
import {
  gateEntityToken,
  entityPlaceholder,
  describeEntity,
  type WmsEntityKind,
} from "./wmsEntityScan";

export type EntityScanState = "idle" | "checking" | "confirmed" | "rejected";

/** Caller's verdict on an admitted code. */
export interface EntityResolution {
  ok: boolean;
  /** Short confirmation or refusal line shown under the field. */
  message: string;
}

interface Props {
  label: string;
  intent: WmsScanIntent;
  entity: WmsEntityKind;
  disabled?: boolean;
  placeholder?: string;
  /** Clear the field after a successful resolve (default true). */
  clearOnSuccess?: boolean;
  /**
   * Resolve an admitted code against the surface's own domain. Returning
   * `ok: false` shows `message` as a blocking refusal with error feedback.
   */
  onResolve: (code: string, ctx: { sscc: string | null; raw: string }) => Promise<EntityResolution> | EntityResolution;
}

export function EntityScanField({
  label,
  intent,
  entity,
  disabled,
  placeholder,
  clearOnSuccess = true,
  onResolve,
}: Props) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<EntityScanState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const feedback = useScanFeedback();

  const check = useCallback(
    async (raw: string) => {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) {
        setState("idle");
        setMessage(null);
        return;
      }
      const gated = gateEntityToken(trimmed, entity);
      if (gated.refusal) {
        setState("rejected");
        setMessage(gated.refusal);
        feedback.error();
        return;
      }
      setState("checking");
      try {
        const verdict = await onResolve(gated.code, { sscc: gated.sscc, raw: trimmed });
        if (!verdict.ok) {
          setState("rejected");
          setMessage(verdict.message);
          feedback.error();
          return;
        }
        setState("confirmed");
        setMessage(verdict.message);
        feedback.success();
        if (clearOnSuccess) setValue("");
      } catch (err) {
        setState("rejected");
        setMessage(err instanceof Error ? err.message : `Could not resolve ${describeEntity(entity)}.`);
        feedback.error();
      }
    },
    [entity, onResolve, feedback, clearOnSuccess],
  );

  useWmsScanIntent({
    intent,
    label: `wms:${intent}:field`,
    enabled: !disabled,
    onScan: ({ resolveCode, raw }) => {
      const shown = resolveCode || raw;
      setValue(shown);
      void check(shown);
    },
  });

  useEffect(() => {
    if (disabled) {
      setState("idle");
      setMessage(null);
    }
  }, [disabled]);

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <ScanBarcode className="h-4 w-4" /> {label}
        <ScanCameraButton label={label} disabled={disabled} className="ml-auto" />
      </Label>
      <Input
        className={cn(
          "h-12 font-mono text-base",
          state === "confirmed" && "border-primary",
          state === "rejected" && "border-destructive",
        )}
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        placeholder={placeholder ?? entityPlaceholder(entity)}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
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