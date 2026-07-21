/**
 * PrintLabelButton — shared UI seam for every "Print label" action in the
 * app. Wraps `useLabelPrint` (which owns barcode-identity refusal,
 * missing-device CTA, workflow routing and toast copy per ADR-0086/0089)
 * so pages never touch `printLabelByTemplate`, `hardwareClient`, or raw
 * driver bytes directly.
 *
 * This is the canonical caller-side component referenced by
 * `src/test/printing/label-coverage.test.ts`.
 */
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLabelPrint } from "@/hooks/inventory/useLabelPrint";
import type {
  PrintLabelArgs,
  UseLabelPrintOptions,
} from "@/hooks/inventory/useLabelPrint";

export interface PrintLabelButtonProps extends Omit<PrintLabelArgs, never> {
  label?: string;
  size?: "default" | "sm" | "lg" | "icon";
  variant?:
    | "default"
    | "secondary"
    | "outline"
    | "ghost"
    | "destructive"
    | "link";
  className?: string;
  disabled?: boolean;
  scope?: UseLabelPrintOptions;
  showIcon?: boolean;
  /** Optional callback fired after dispatch (success or failure). */
  onComplete?: (result: { success: boolean; error?: string }) => void;
}

export function PrintLabelButton({
  label = "Print label",
  size = "sm",
  variant = "outline",
  className,
  disabled,
  scope,
  showIcon = true,
  onComplete,
  ...printArgs
}: PrintLabelButtonProps) {
  const { print } = useLabelPrint(scope);
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={disabled}
      onClick={async (e) => {
        e.stopPropagation();
        const r = await print(printArgs);
        onComplete?.({ success: r.success, error: r.error });
      }}
    >
      {showIcon ? <Printer className="h-3.5 w-3.5 mr-1.5" /> : null}
      {label}
    </Button>
  );
}

export default PrintLabelButton;