import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface InvoiceDeliveryStatus {
  found: boolean;
  invoice_id?: string;
  invoice_status?: string;
  has_stockable_lines?: boolean;
  stockable_line_count?: number;
  sales_order_id?: string | null;
  delivery_note_id?: string | null;
  delivery_number?: string | null;
  delivery_status?: string | null;
  delivered_at?: string | null;
}

/**
 * Reports whether an invoice has stockable lines and the status of its
 * linked Delivery Note (auto-created by `confirm_invoice_atomic` for
 * invoices that contain tracked-stock products and have no SO link).
 *
 * Stock is only released when the delivery is *completed* — until then
 * the invoice should display a "Delivery pending — stock not yet
 * reduced" banner and a one-click "Complete Delivery" action.
 */
export function useInvoiceDeliveryStatus(invoiceId: string | null | undefined) {
  return useQuery<InvoiceDeliveryStatus>({
    queryKey: ["invoice-delivery-status", invoiceId],
    enabled: !!invoiceId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "get_invoice_delivery_status" as any,
        { p_invoice_id: invoiceId },
      );
      if (error) throw error;
      return (data ?? { found: false }) as InvoiceDeliveryStatus;
    },
  });
}
