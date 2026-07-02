/**
 * ADR 0012 — Legacy entry point. Now a thin shell over ReversePaymentWizard.
 * Existing call sites keep working; the guided wizard captures the reason
 * intent that this dialog previously dropped on the floor.
 */
import { ReversePaymentWizard } from "./ReversePaymentWizard";

interface VoidPaymentDialogProps {
  payment: {
    id: string;
    receipt_number: string;
    amount: number;
    outstanding_amount?: number | null;
    applied_amount?: number | null;
    payment_date: string;
    invoice?: { id?: string; invoice_number: string } | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function VoidPaymentDialog(props: VoidPaymentDialogProps) {
  return <ReversePaymentWizard {...props} />;
}
