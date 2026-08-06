/**
 * ScanTextField — a plain text prompt that is also a real scan target.
 *
 * Some prompts are neither a product, a bin, nor a handling unit
 * (`BinScanField` / `ProductScanField` / `EntityScanField` own those):
 * a serial number, a parent plate code in a dialog, a pallet code bound
 * to a receiving session. Before this existed those were bare `<Input>`s,
 * which meant a handheld operator had no way to invoke the camera and a
 * router-delivered scan had nowhere to land.
 *
 * It does two things and nothing else:
 *   1. registers with `scanRouter` while focused (or while the local
 *      viewfinder it opened is on screen) so wedge / ring / paired-phone /
 *      camera decodes all arrive here;
 *   2. renders the single sanctioned `<ScanCameraButton>` affordance.
 *
 * Resolution stays with the caller — this component never interprets a code.
 */
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useScanTarget } from "@/hooks/pos/useScanTarget";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";
import { scanFeedbackBus } from "@/services/scanner";
import type { ScanWorkflow } from "@/services/pos/scanRouter";

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (next: string) => void;
  /**
   * Router-confirmed scan (never typing). Defaults to `onEnter` when
   * omitted, so a scan behaves exactly like typing the code and hitting
   * Enter.
   */
  onScan?: (code: string) => void;
  /** Fired when the operator presses Enter with a non-empty value. */
  onEnter?: (value: string) => void;
  /** Viewfinder header — e.g. "Scan pallet label". Defaults to the placeholder. */
  cameraLabel?: string;
  /** Keep the viewfinder open after each decode (serials, receiving). */
  continuous?: boolean;
  /** Allow the same code repeatedly (counting / receiving semantics). */
  allowRepeats?: boolean;
  workflow?: ScanWorkflow;
  /**
   * Router priority. Defaults to 30 so this field outranks a page-level
   * WMS intent (20) while the operator is actually standing in it.
   */
  priority?: number;
  containerClassName?: string;
}

export interface ScanTextFieldHandle {
  focus: () => void;
}

export const ScanTextField = forwardRef<ScanTextFieldHandle, Props>(function ScanTextField(
  {
    value,
    onChange,
    onScan,
    onEnter,
    cameraLabel,
    continuous,
    allowRepeats,
    workflow = "identity",
    priority = 30,
    className,
    containerClassName,
    placeholder,
    onKeyDown,
    ...rest
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const label = cameraLabel ?? (typeof placeholder === "string" ? placeholder : "Scan");

  useScanTarget({
    active: (focused || cameraOpen) && !rest.disabled,
    priority,
    label: "ScanTextField",
    workflow,
    allowRepeats,
    onScan: (e) => {
      onChange(e.code);
      scanFeedbackBus.emit({
        kind: "ok",
        raw: e.code,
        source: "field",
        workflow,
        fieldLabel: label,
      });
      if (onScan) onScan(e.code);
      else onEnter?.(e.code);
    },
  });

  return (
    <div className={cn("relative", containerClassName)}>
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={cn("pr-10", className)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.key === "Enter" && value.trim()) {
            e.preventDefault();
            onEnter?.(value);
          }
        }}
        {...rest}
      />
      <ScanCameraButton
        label={label}
        continuous={continuous}
        className="absolute right-1 top-1/2 -translate-y-1/2"
        disabled={rest.disabled}
        onBeforeOpen={() => {
          setCameraOpen(true);
          inputRef.current?.focus();
        }}
        onClose={() => setCameraOpen(false)}
      />
    </div>
  );
});
