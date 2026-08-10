/**
 * useInvoiceRecord — the single fetcher the InvoicePeekSheet and
 * InvoiceRecordPage share so the two surfaces cannot drift. Follows the
 * Phase-A.2 contract from docs/design-system/audit/sales.md.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Invoice } from "@/hooks/useInvoices";

interface State {
  invoice: Invoice | null;
  loading: boolean;
  error: string | null;
}

interface Result extends State {
  /** Re-fetch the record — used after an action mutates it. */
  refresh: () => void;
}

export function useInvoiceRecord(id: string | null | undefined): Result {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<State>({
    invoice: null,
    loading: !!id,
    error: null,
  });

  useEffect(() => {
    if (!id) {
      setState({ invoice: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(
          "*, contact:contacts(name, email, phone), invoice_items(*)",
        )
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setState({ invoice: null, loading: false, error: error.message });
      } else if (!data) {
        setState({ invoice: null, loading: false, error: "Invoice not found." });
      } else {
        setState({ invoice: data as unknown as Invoice, loading: false, error: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
