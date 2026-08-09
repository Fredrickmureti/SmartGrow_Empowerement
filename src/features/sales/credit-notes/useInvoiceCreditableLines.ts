/**
 * useInvoiceCreditableLines — loads the *still creditable* lines of the
 * invoice a credit note is being raised against.
 *
 * A credit note is a reverse-reference document: its lines are picked off the
 * source invoice, not retyped. The source of truth is the database view
 * `v_invoice_creditable_qty`, which nets what was invoiced against everything
 * already credited by non-void credit notes. The same ceiling is re-enforced
 * inside `create_credit_note_atomic`, so this hook is a convenience for the
 * operator, not the control.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CreditableInvoiceLine {
  invoice_item_id: string;
  product_id: string | null;
  description: string;
  invoiced_qty: number;
  /** Quantity already credited by other, non-void credit notes. */
  credited_qty: number;
  /** Quantity still available to credit. */
  remaining_qty: number;
  /** Unit price net of the original line discount. */
  net_unit_price: number;
  unit_price: number;
  discount_percent: number;
  tax_rate: number;
  remaining_net_amount: number;
}

export function useInvoiceCreditableLines(
  invoiceId: string | null | undefined,
  /** Exclude this credit note's own lines from the consumed quantity (edit mode). */
  excludeCreditNoteId?: string | null,
) {
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
        const { data, error: err } = await (supabase as any)
          .from("v_invoice_creditable_qty")
          .select(
            "invoice_item_id, product_id, description, invoiced_qty, credited_qty, remaining_qty, unit_price, discount_percent, net_unit_price, tax_rate, remaining_net_amount",
          )
          .eq("invoice_id", invoiceId);
        if (err) throw err;

        // In edit mode the credit note being edited has already consumed part
        // of the ceiling; give it back so its own lines stay adjustable.
        const ownQty: Record<string, number> = {};
        if (excludeCreditNoteId) {
          const { data: own } = await supabase
            .from("credit_note_items")
            .select("invoice_item_id, quantity")
            .eq("credit_note_id", excludeCreditNoteId);
          for (const row of (own ?? []) as Array<{ invoice_item_id: string | null; quantity: number }>) {
            if (row.invoice_item_id) {
              ownQty[row.invoice_item_id] = (ownQty[row.invoice_item_id] ?? 0) + Number(row.quantity || 0);
            }
          }
        }

        const mapped: CreditableInvoiceLine[] = (data ?? []).map((row: any) => {
          const giveBack = ownQty[row.invoice_item_id] ?? 0;
          const invoiced = Number(row.invoiced_qty) || 0;
          const netUnit = Number(row.net_unit_price) || 0;
          const credited = Math.max((Number(row.credited_qty) || 0) - giveBack, 0);
          const remaining = Math.max(invoiced - credited, 0);
          return {
            invoice_item_id: row.invoice_item_id,
            product_id: row.product_id ?? null,
            description: row.description ?? "",
            invoiced_qty: invoiced,
            credited_qty: credited,
            remaining_qty: remaining,
            unit_price: Number(row.unit_price) || 0,
            discount_percent: Number(row.discount_percent) || 0,
            net_unit_price: netUnit,
            tax_rate: Number(row.tax_rate) || 0,
            remaining_net_amount: Number((remaining * netUnit).toFixed(2)),
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
  }, [invoiceId, excludeCreditNoteId]);

  return { lines, isLoading, error };
}
