import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import {
  WorkflowSheet,
  WorkflowSheetSection,
} from "@/components/workflow/WorkflowSheet";

export interface CompensationBlocker {
  code: string;
  reason: string;
  remediation_label?: string;
  remediation_link?: string;
}

export interface CompensationSetupPayload {
  is_ready?: boolean;
  contract_id?: string;
  employee_id?: string;
  blockers: CompensationBlocker[];
}

interface CompensationSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: CompensationSetupPayload | null;
}

/**
 * Surfaces a structured 'CONTRACT_COMPENSATION_INCOMPLETE' payload
 * (raised by the enforce_contract_compensation_on_activation DB trigger
 * or returned by assert_contract_compensation_ready) as a remediation
 * sheet with deep links — never a raw Postgres error string.
 *
 * Migrated to the WorkflowSheet design standard.
 */
export function CompensationSetupDialog({
  open,
  onOpenChange,
  payload,
}: CompensationSetupDialogProps) {
  const blockers = payload?.blockers ?? [];
  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          Compensation setup is incomplete
        </span>
      }
      description="This contract cannot be activated until its compensation method is fully configured. Fix the items below and try again."
      footer={
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      <WorkflowSheetSection
        number={1}
        title="Blockers"
        subtitle="Each item below blocks activation. Open the linked page to remediate."
      >
        <ul className="space-y-3">
          {blockers.map((b) => (
            <li
              key={b.code}
              className="rounded-md border bg-muted/40 p-3 text-sm"
            >
              <div className="font-medium">{b.reason}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Code: <span className="font-mono">{b.code}</span>
              </div>
              {b.remediation_link ? (
                <div className="mt-2">
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                  >
                    <Link to={b.remediation_link}>
                      {b.remediation_label ?? "Open"}
                    </Link>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
          {blockers.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              No specific blockers reported.
            </li>
          ) : null}
        </ul>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
