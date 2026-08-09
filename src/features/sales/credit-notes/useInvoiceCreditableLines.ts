/**
 * useInvoiceCreditableLines — loads the lines of the invoice a credit note is
 * being raised against.
 *
 * A credit note is a reverse-reference document: its lines should be *picked*
 * off the source invoice, not retyped. The list query (`useInvoices`) never
 * selects `invoice_items`, so this hook fetches them on demand for exactly one
 * invoice.
 *
 * Note: `credit_note_items` has no `invoice_item_id` column, so this hook is a
 * presentation-side seeder — it copies the invoice line's description, net
 * unit price and tax rate onto the credit line rather than storing a link.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CreditableInvoiceLine {
  invoice_item_id: string;
  product_id: string | null;
  description: string;
  invoiced_qty: number;
  /** Unit price net of the original line discount. */
  net_unit_price: number;
  unit_price: number;
  discount_percent: number;
  tax_rate: number;
  tax_amount: number;
  packaging_id: string | null;
  display_uom_id: string | null;
  display_quantity: number | null;
  uom_snapshot: unknown | null;
}

export function useInvoiceCreditableLines(invoiceId: string | null | undefined) {
  const [lines, setLines] = useState<CreditableInvoiceLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!invoiceId) {
      setLines([]);
      setError(null);
      return;
    }

    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const { data, error: err } = await supabase
          .from("invoice_items")
          .select(
            "id, product_id, description, quantity, unit_price, discount_percent, tax_rate, tax_amount, packaging_id, display_uom_id, display_quantity, uom_snapshot, sort_order",
          )
          .eq("invoice_id", invoiceId)
          .order("sort_order", { ascending: true });
        if (err) throw err;

        const mapped: CreditableInvoiceLine[] = (data ?? []).map((item: any) => {
          const unitPrice = Number(item.unit_price) || 0;
          const discount = Number(item.discount_percent) || 0;
          return {
            invoice_item_id: item.id,
            product_id: item.product_id ?? null,
            description: item.description ?? "",
            invoiced_qty: Number(item.quantity) || 0,
            unit_price: unitPrice,
            discount_percent: discount,
            net_unit_price: unitPrice * (1 - discount / 100),
            tax_rate: Number(item.tax_rate) || 0,
            tax_amount: Number(item.tax_amount) || 0,
            packaging_id: item.packaging_id ?? null,
            display_uom_id: item.display_uom_id ?? null,
            display_quantity: item.display_quantity ?? null,
            uom_snapshot: item.uom_snapshot ?? null,
          };
        });

        if (!cancelled) setLines(mapped);
      } catch (e: any) {
        if (!cancelled) {
          setLines([]);
          setError(e?.message ?? "Could not load invoice lines");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoiceId]);

  return { lines, isLoading, error };
}
