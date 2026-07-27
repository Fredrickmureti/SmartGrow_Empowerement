/**
 * useHardwareDisplay — batched business-identity resolvers for the
 * Hardware Operations Workspace.
 *
 * Given a list of print/hardware rows carrying `(doc_type, doc_id)`,
 * `requested_by`, and `printer_profile_id`, these hooks return a Map
 * of id → human label so the primary tables can render things like
 * "Invoice INV-2026-0143" and "Alice K." instead of raw UUIDs.
 *
 * All lookups are batched (one query per doc_type / one query for
 * profiles / one query for devices) and cached for 60 s.
 *
 * Missing / inaccessible rows fall back gracefully to
 * "<Doc type> · <short id>".
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { docTypeLabel, shortId } from "../lib/humanize";

export interface DisplayLabel {
  label: string;
  secondary?: string;
}

/**
 * doc_type → { table, numberColumn } mapping. Anything not in this
 * list falls through to "<humanized doc_type> · <short id>".
 */
const DOC_SOURCES: Record<string, { table: string; numberColumn: string }> = {
  invoice: { table: "invoices", numberColumn: "invoice_number" },
  credit_note: { table: "credit_notes", numberColumn: "credit_note_number" },
  vendor_credit_note: { table: "vendor_credit_notes", numberColumn: "credit_note_number" },
  delivery_note: { table: "delivery_notes", numberColumn: "delivery_number" },
  purchase_order: { table: "purchase_orders", numberColumn: "po_number" },
  sales_order: { table: "sales_orders", numberColumn: "so_number" },
  estimate: { table: "estimates", numberColumn: "estimate_number" },
  bill: { table: "bills", numberColumn: "bill_number" },
  receipt: { table: "pos_transactions", numberColumn: "receipt_number" },
  pos_receipt: { table: "pos_transactions", numberColumn: "receipt_number" },
  pos_transaction: { table: "pos_transactions", numberColumn: "receipt_number" },
  proforma_invoice: { table: "proforma_invoices", numberColumn: "invoice_number" },
};

/**
 * Given a list of `{doc_type, doc_id}` pairs, return a Map keyed by
 * `doc_id` with a human label like `"Invoice INV-2026-0143"`.
 */
export function useDocumentDisplay(rows: Array<{ doc_type: string; doc_id: string | null }>) {
  const key = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const r of rows) {
      if (!r.doc_id) continue;
      const source = DOC_SOURCES[r.doc_type];
      if (!source) continue;
      (groups[r.doc_type] ??= []).push(r.doc_id);
    }
    // Stable cache key: sorted per group.
    const parts = Object.entries(groups)
      .map(([t, ids]) => `${t}:${[...new Set(ids)].sort().join(",")}`)
      .sort();
    return parts.join("|");
  }, [rows]);

  const query = useQuery({
    queryKey: ["hardware", "document-display", key],
    staleTime: 60_000,
    queryFn: async () => {
      const groups: Record<string, string[]> = {};
      for (const r of rows) {
        if (!r.doc_id) continue;
        if (!DOC_SOURCES[r.doc_type]) continue;
        (groups[r.doc_type] ??= []).push(r.doc_id);
      }
      const out = new Map<string, DisplayLabel>();
      await Promise.all(
        Object.entries(groups).map(async ([docType, ids]) => {
          const source = DOC_SOURCES[docType];
          if (!source) return;
          const unique = [...new Set(ids)];
          const { data, error } = await supabase
            .from(source.table as never)
            .select(`id, ${source.numberColumn}`)
            .in("id", unique);
          if (error || !data) return;
          const rowsAny = data as Array<Record<string, unknown>>;
          for (const row of rowsAny) {
            const id = row.id as string;
            const num = row[source.numberColumn] as string | null;
            out.set(id, {
              label: `${docTypeLabel(docType)} ${num ?? shortId(id)}`,
            });
          }
        }),
      );
      return out;
    },
  });

  return (docType: string, docId: string | null): DisplayLabel => {
    if (!docId) return { label: docTypeLabel(docType) };
    const hit = query.data?.get(docId);
    if (hit) return hit;
    return { label: `${docTypeLabel(docType)} · ${shortId(docId)}` };
  };
}

/**
 * user_id → display name. Falls back to email, then to short id.
 */
export function useRequesterDisplay(userIds: Array<string | null>) {
  const unique = useMemo(
    () => [...new Set(userIds.filter((v): v is string => !!v))].sort(),
    [userIds],
  );
  const key = unique.join(",");

  const query = useQuery({
    queryKey: ["hardware", "requester-display", key],
    staleTime: 60_000,
    enabled: unique.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", unique);
      const out = new Map<string, DisplayLabel>();
      for (const row of data ?? []) {
        out.set(row.id, {
          label: (row.full_name && row.full_name.trim()) || row.email || shortId(row.id),
        });
      }
      return out;
    },
  });

  return (userId: string | null): DisplayLabel => {
    if (!userId) return { label: "System" };
    return query.data?.get(userId) ?? { label: shortId(userId) };
  };
}

/**
 * printer_profile_id → display name from device_assignments.
 */
export function usePrinterDisplay(printerIds: Array<string | null>) {
  const unique = useMemo(
    () => [...new Set(printerIds.filter((v): v is string => !!v))].sort(),
    [printerIds],
  );
  const key = unique.join(",");

  const query = useQuery({
    queryKey: ["hardware", "printer-display", key],
    staleTime: 60_000,
    enabled: unique.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("device_assignments")
        .select("id, display_name, role, transport, driver")
        .in("id", unique);
      const out = new Map<string, DisplayLabel>();
      for (const row of data ?? []) {
        out.set(row.id, {
          label: row.display_name || shortId(row.id),
          secondary: [row.role, row.transport].filter(Boolean).join(" · "),
        });
      }
      return out;
    },
  });

  return (printerId: string | null): DisplayLabel => {
    if (!printerId) return { label: "Not routed to a printer" };
    return query.data?.get(printerId) ?? { label: shortId(printerId) };
  };
}