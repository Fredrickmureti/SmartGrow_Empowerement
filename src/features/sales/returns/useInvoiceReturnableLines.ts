/**
 * useInvoiceReturnableLines — loads one invoice's lines together with the
 * remaining returnable quantity per line.
 *
 * The global `useInvoices` list query deliberately does NOT select line
 * items (it powers list screens), so the returns form must fetch them on
 * demand. `v_sales_returnable_qty` is the ledger of record for how much of
 * each invoice line is still returnable after prior returns — the UI must
 * never re-derive that number.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ReturnableInvoiceLine {
  invoice_item_id: string;
  product_id: string | null;
  description: string;
  invoiced_qty: number;
  returned_qty: number;
  returnable_qty: number;
  /** Unit price net of the original line discount. */
  net_unit_price: number;
  unit_price: number;
  discount_percent: number;
  tax_rate: number;
  /** Tax charged on the whole original line. */
  source_tax_amount: number;
  packaging_id: string | null;
  display_uom_id: string | null;
  display_quantity: number | null;
}

export function useInvoiceReturnableLines(invoiceId: string | null | undefined) {
  const [lines, setLines] = useState<ReturnableInvoiceLine[]>([]);
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
        const [itemsRes, ledgerRes] = await Promise.all([
          supabase
            .from("invoice_items")
            .select(
              "id, product_id, description, quantity, unit_price, discount_percent, tax_rate, tax_amount, packaging_id, display_uom_id, display_quantity, sort_order",
            )
            .eq("invoice_id", invoiceId)
            .order("sort_order", { ascending: true }),
          supabase
            .from("v_sales_returnable_qty")
            .select("invoice_item_id, invoiced_qty, returned_qty, returnable_qty")
            .eq("invoice_id", invoiceId),
        ]);

        if (itemsRes.error) throw itemsRes.error;
        if (ledgerRes.error) throw ledgerRes.error;

        const ledger = new Map(
          (ledgerRes.data ?? []).map((r: any) => [r.invoice_item_id as string, r]),
        );

        const mapped: ReturnableInvoiceLine[] = (itemsRes.data ?? []).map((item: any) => {
          const invoicedQty = Number(item.quantity) || 0;
          const l = ledger.get(item.id);
          const discount = Number(item.discount_percent) || 0;
          const unitPrice = Number(item.unit_price) || 0;
          return {
            invoice_item_id: item.id,
            product_id: item.product_id ?? null,
            description: item.description ?? "",
            invoiced_qty: l ? Number(l.invoiced_qty) || invoicedQty : invoicedQty,
            returned_qty: l ? Number(l.returned_qty) || 0 : 0,
            // Absent from the ledger view = nothing returned yet.
            returnable_qty: l ? Number(l.returnable_qty) || 0 : invoicedQty,
            unit_price: unitPrice,
            discount_percent: discount,
            net_unit_price: unitPrice * (1 - discount / 100),
            tax_rate: Number(item.tax_rate) || 0,
            source_tax_amount: Number(item.tax_amount) || 0,
            packaging_id: item.packaging_id ?? null,
            display_uom_id: item.display_uom_id ?? null,
            display_quantity: item.display_quantity ?? null,
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
