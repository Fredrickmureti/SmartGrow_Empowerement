import { useDocumentRecord } from "@/design-system/records";
import type { Payment } from "@/hooks/usePayments";

export function useCustomerPaymentRecord(id: string | null | undefined) {
  return useDocumentRecord<Payment>({
    table: "payments",
    select:
      "*, contact:contacts(name), payment_allocations(amount, invoice:invoices(id, invoice_number, total))",
    id,
    entityLabel: "Payment",
  });
}
