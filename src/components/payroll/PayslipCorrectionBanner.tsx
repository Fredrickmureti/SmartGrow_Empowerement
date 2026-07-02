/**
 * Phase 4 P3 — Correction visibility banners.
 *
 * Renders one of two country-agnostic banners on a payslip:
 *   - "Superseded by …" when this payslip has been reversed/corrected.
 *   - "Corrects …"      when this payslip *is* the reversal/correction.
 *
 * Banners are intentionally neutral text — no statutory vocabulary, no
 * jurisdiction-specific phrasing.
 */
import { ArrowRight, RotateCcw, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { usePayslipCorrectionLinks, type PayslipLinkRef } from "@/hooks/payroll/usePayslipCorrectionLinks";

interface Props {
  payslipId: string | null | undefined;
  onOpenPayslip?: (payslipId: string) => void;
}

function fmtPeriod(ref: PayslipLinkRef): string {
  if (ref.pay_period_start && ref.pay_period_end) {
    try {
      const s = new Date(ref.pay_period_start).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      const e = new Date(ref.pay_period_end).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      return `${s} – ${e}`;
    } catch {
      /* fall through */
    }
  }
  return ref.payroll_number ?? ref.id.slice(0, 8);
}

export function PayslipCorrectionBanner({ payslipId, onOpenPayslip }: Props) {
  const { data, isLoading } = usePayslipCorrectionLinks(payslipId);
  if (isLoading || !data) return null;
  const { supersededBy, corrects } = data;
  if (!supersededBy && !corrects) return null;

  if (supersededBy) {
    return (
      <Alert variant="destructive" className="mb-2">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="text-sm">Superseded by a correction</AlertTitle>
        <AlertDescription className="text-xs flex flex-wrap items-center gap-2">
          <span>
            This payslip was reversed by{" "}
            <span className="font-mono">{supersededBy.payroll_number ?? supersededBy.id.slice(0, 8)}</span>{" "}
            <span className="text-muted-foreground">({fmtPeriod(supersededBy)})</span>.
          </span>
          {onOpenPayslip && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => onOpenPayslip(supersededBy.id)}
            >
              Open correction <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  // corrects !== null
  return (
    <Alert className="mb-2 border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20">
      <RotateCcw className="h-4 w-4" />
      <AlertTitle className="text-sm">Correction payslip</AlertTitle>
      <AlertDescription className="text-xs flex flex-wrap items-center gap-2">
        <span>
          This payslip reverses{" "}
          <span className="font-mono">{corrects!.payroll_number ?? corrects!.id.slice(0, 8)}</span>{" "}
          <span className="text-muted-foreground">({fmtPeriod(corrects!)})</span>.
        </span>
        {onOpenPayslip && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => onOpenPayslip(corrects!.id)}
          >
            Open original <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
