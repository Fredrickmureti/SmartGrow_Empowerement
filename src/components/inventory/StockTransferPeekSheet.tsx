/**
 * StockTransferPeekSheet — the drawer projection of a stock transfer.
 *
 * Rebuilt onto the canonical `DocumentRecordView` + `PeekScaffold` pair so
 * the transfer drawer shares the platform's status vocabulary and the
 * container-adaptive line grid instead of a bespoke sheet with its own
 * colour map and `<Table>`.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";

import { PeekScaffold } from "@/design-system/records";
import type {
  DocumentRecordView,
  LineItemColumn,
  LineItemRow,
} from "@/design-system/records";
import { supabase } from "@/integrations/supabase/client";

interface StockTransferPeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transferId: string | null;
}

const COLUMNS: LineItemColumn[] = [
  { id: "product", header: "Product", priority: 1, minWidth: 200 },
  { id: "requested", header: "Requested", numeric: true, priority: 1, minWidth: 100, compactLabel: "Req." },
  { id: "sent", header: "Sent", numeric: true, priority: 2, minWidth: 90 },
  { id: "received", header: "Received", numeric: true, priority: 2, minWidth: 100, compactLabel: "Recv." },
];

const fmtDate = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

export function StockTransferPeekSheet({
  open,
  onOpenChange,
  transferId,
}: StockTransferPeekSheetProps) {
  const { data: transfer, isLoading } = useQuery({
    queryKey: ["transfer-detail-drawer", transferId],
    queryFn: async () => {
      if (!transferId) return null;
      const { data, error } = await supabase
        .from("stock_transfers")
        .select(`
          *,
          from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(id, name, code),
          to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(id, name, code),
          stock_transfer_items(*, products(id, name, sku))
        `)
        .eq("id", transferId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!transferId && open,
  });

  const createdBy = (transfer as any)?.created_by as string | undefined;
  const { data: creator } = useQuery({
    queryKey: ["profile", createdBy],
    queryFn: async () => {
      if (!createdBy) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", createdBy)
        .maybeSingle();
      return data;
    },
    enabled: !!createdBy && open,
  });

  const view = useMemo<DocumentRecordView>(() => {
    const items: any[] = (transfer as any)?.stock_transfer_items ?? [];
    const rows: LineItemRow[] = items.map((item, idx) => ({
      id: item.id ?? String(idx),
      cells: [
        {
          columnId: "product",
          content: (
            <span className="block min-w-0">
              <span className="block truncate font-medium">
                {item.products?.name || "—"}
              </span>
              {item.products?.sku && (
                <span className="block truncate text-xs text-muted-foreground">
                  {item.products.sku}
                </span>
              )}
            </span>
          ),
        },
        {
          columnId: "requested",
          content: item.quantity_requested ?? item.quantity ?? 0,
        },
        { columnId: "sent", content: item.quantity_sent ?? "—" },
        { columnId: "received", content: item.quantity_received ?? "—" },
      ],
    }));

    const from = (transfer as any)?.from_warehouse?.name;
    const to = (transfer as any)?.to_warehouse?.name;

    return {
      kind: "stock_transfer",
      documentId: transfer?.id,
      eyebrow: "Stock Transfer",
      listPath: "/warehouse-app/warehouses",
      title: transfer?.transfer_number ?? "Transfer",
      docNumber: transfer?.transfer_number,
      status: transfer?.status,
      loading: isLoading,
      notFound: !isLoading && !!transferId && !transfer,
      meta: transfer ? (
        <>
          <span>{fmtDate(transfer.transfer_date)}</span>
          <span>
            {from || "—"} → {to || "—"}
          </span>
        </>
      ) : undefined,
      detailFields: transfer
        ? [
            { label: "Date", value: fmtDate(transfer.transfer_date) },
            { label: "From warehouse", value: from || "—" },
            { label: "To warehouse", value: to || "—" },
            {
              label: "Created by",
              value: creator?.full_name || creator?.email || "—",
            },
            { label: "Notes", value: transfer.notes || "—" },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No items on this transfer.",
    };
  }, [creator, isLoading, transfer, transferId]);

  return (
    <PeekScaffold
      {...view}
      open={open}
      onOpenChange={onOpenChange}
      fullPageHref={
        transferId ? `/warehouse-app/warehouses?selected=${transferId}` : undefined
      }
    />
  );
}

export default StockTransferPeekSheet;
