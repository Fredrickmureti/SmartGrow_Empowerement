/**
 * Host that bridges WorkflowMatrix cell clicks to the generic WorkflowDrawer.
 * Calls every workflow hook unconditionally (hooks rule) and renders the
 * snapshot matching the selected column.
 */
import { useMemo } from "react";
import { WorkflowDrawer } from "./WorkflowDrawer";
import {
  usePayrollPostingWorkflow,
  usePayrollPaymentWorkflow,
  usePayrollBankFileWorkflow,
  usePayrollReturnsWorkflow,
} from "@/hooks/payroll/workflows/usePayrollWorkflows";
import type { WorkflowCol } from "./WorkflowMatrix";
import type { WorkflowSnapshot } from "@/hooks/payroll/workflows/types";

interface Props {
  runId: string | null;
  col: WorkflowCol | null;
  onClose: () => void;
}

const TITLES: Record<WorkflowCol, { title: string; description: string }> = {
  calc: { title: "Calculation", description: "Draft → Calculating → Calculated → Approved. Approval is the immutability seal." },
  payslips: { title: "Payslips", description: "Issuance & distribution. Peers of Approval, independent of GL Posting and Payment." },
  posting: { title: "GL Posting", description: "Post the payroll journal entry. Requires Approval only." },
  payment: { title: "Payment", description: "Employee disbursement projected from payment batches." },
  bank: { title: "Bank File", description: "Bank export lifecycle. Sent / acknowledged / waived are terminal." },
  returns: { title: "Statutory Returns", description: "Available immediately after Approval — never gated on Payment." },
};

export function WorkflowMatrixDrawerHost({ runId, col, onClose }: Props) {
  const posting = usePayrollPostingWorkflow(runId);
  const payment = usePayrollPaymentWorkflow(runId);
  const bank = usePayrollBankFileWorkflow(runId);
  const returns = usePayrollReturnsWorkflow(runId);

  const snapshot: WorkflowSnapshot | null = useMemo(() => {
    if (!col) return null;
    switch (col) {
      case "posting": return posting;
      case "payment": return payment;
      case "bank": return bank;
      case "returns": return returns;
      // calc & payslips: return the closest projection so the drawer still renders.
      case "calc": return { ...posting, workflow: "posting", state: posting.state, preconditions: posting.preconditions };
      case "payslips": return { ...posting, workflow: "posting", state: posting.state, preconditions: posting.preconditions };
    }
  }, [col, posting, payment, bank, returns]);

  const open = !!runId && !!col && !!snapshot;
  const meta = col ? TITLES[col] : null;

  return (
    <WorkflowDrawer
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={meta?.title ?? ""}
      description={meta?.description}
      snapshot={snapshot ?? posting}
      runId={runId}
    />
  );
}