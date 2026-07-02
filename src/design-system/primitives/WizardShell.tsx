/**
 * WizardShell — the single approved skeleton for guided multi-step flows
 * (Convert Quote→SO, Receive PO, Stock Take, Payroll Run, …).
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ <RecordHeader>                                               │
 *   │ [ 1 Details ]─[ 2 Lines ]─[ 3 Review ]                       │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │  current step body                                           │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ [ Back ]                     [ Save draft ] [ Next / Submit ] │
 *   └─────────────────────────────────────────────────────────────┘
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

export interface WizardStep {
  id: string;
  label: ReactNode;
  /** Optional short description under the label. */
  description?: ReactNode;
}

interface WizardStepperProps {
  steps: WizardStep[];
  activeStepId: string;
  /** Ids of steps considered complete. */
  completedStepIds?: string[];
  /** Called when a step chip is clicked (only completed steps are clickable). */
  onStepClick?: (stepId: string) => void;
  className?: string;
}

export function WizardStepper({
  steps,
  activeStepId,
  completedStepIds = [],
  onStepClick,
  className,
}: WizardStepperProps) {
  return (
    <ol
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-2 border-b bg-background/95 px-1 py-3 backdrop-blur sm:px-6",
        className,
      )}
    >
      {steps.map((step, index) => {
        const isActive = step.id === activeStepId;
        const isComplete = completedStepIds.includes(step.id);
        const clickable = isComplete && onStepClick;
        return (
          <li key={step.id} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!clickable}
              onClick={clickable ? () => onStepClick!(step.id) : undefined}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
                isActive
                  ? "border-primary bg-primary/10 text-foreground"
                  : isComplete
                    ? "border-emerald-500/40 bg-emerald-500/5 text-foreground"
                    : "border-border bg-transparent text-muted-foreground",
                clickable
                  ? "cursor-pointer hover:bg-muted/60"
                  : "cursor-default",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : isComplete
                      ? "bg-emerald-500 text-white"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {isComplete ? <Check className="h-3 w-3" /> : index + 1}
              </span>
              <span className="font-medium">{step.label}</span>
            </button>
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className="hidden h-px w-6 bg-border sm:inline-block"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

interface WizardShellProps {
  header: ReactNode;
  stepper: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function WizardShell({
  header,
  stepper,
  children,
  footer,
  className,
}: WizardShellProps) {
  return (
    <div className={cn("w-full", footer && "pb-24", className)}>
      {header}
      {stepper}
      <div className="mx-auto w-full max-w-[var(--ds-page-max-width)] px-1 py-6 sm:px-6">
        <div className="mx-auto max-w-4xl space-y-6">{children}</div>
      </div>
      {footer}
    </div>
  );
}