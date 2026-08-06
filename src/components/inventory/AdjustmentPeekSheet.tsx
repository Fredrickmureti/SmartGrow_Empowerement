/**
 * AdjustmentPeekSheet — the drawer projection of a stock adjustment.
 *
 * This used to be a hand-rolled `DetailSheet` with its own status colour map
 * and its own `<Table>` of items, i.e. a second document renderer living
 * outside the design system. It is now a `DocumentRecordView` descriptor
 * projected through `PeekScaffold`, exactly like every Sales and Purchases
 * peek: one renderer, one status vocabulary, one adaptive line grid.
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

interface AdjustmentPeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adjustmentId: string | null;
}

const COLUMNS: LineItemColumn[] = [
  { id: "product", header: "Product", priority: 1, minWidth: 200 },
  { id: "before", header: "Before", numeric: true, priority: 3, minWidth: 90 },
  { id: "change", header: "Change", numeric: true, priority: 1, minWidth: 90 },
  { id: "after", header: "After", numeric: true, priority: 2, minWidth: 90 },
];

const fmtDate = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

export function AdjustmentPeekSheet({
  open,
  onOpenChange,
  adjustmentId,
}: AdjustmentPeekSheetProps) {
  const { data: adjustment, isLoading } = useQuery({
    queryKey: ["adjustment-detail-drawer", adjustmentId],
    queryFn: async () => {
      if (!adjustmentId) return null;
      const { data, error } = await supabase
        .from("stock_adjustments")
        .select(`*, stock_adjustment_items(*, products(id, name, sku))`)
        .eq("id", adjustmentId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!adjustmentId && open,
  });

  const { data: creator } = useQuery({
    queryKey: ["profile", adjustment?.created_by],
    queryFn: async () => {
      if (!adjustment?.created_by) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", adjustment.created_by)
        .maybeSingle();
      return data;
    },
    enabled: !!adjustment?.created_by && open,
  });

  const { data: approver } = useQuery({
    queryKey: ["profile", adjustment?.approved_by],
    queryFn: async () => {
      if (!adjustment?.approved_by) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", adjustment.approved_by)
        .maybeSingle();
      return data;
    },
    enabled: !!adjustment?.approved_by && open,
  });

  const view = useMemo<DocumentRecordView>(() => {
    const items: any[] = (adjustment as any)?.stock_adjustment_items ?? [];
    const rows: LineItemRow[] = items.map((item, idx) => {
      const change = Number(item.quantity_adjustment ?? 0);
      return {
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
          { columnId: "before", content: item.quantity_before ?? "—" },
          {
            columnId: "change",
            content: (
              <span
                className={
                  change >= 0
                    ? "font-medium text-emerald-600 dark:text-emerald-400"
                    : "font-medium text-destructive"
                }
              >
                {change >= 0 ? "+" : ""}
                {change}
              </span>
            ),
          },
          { columnId: "after", content: item.quantity_after ?? "—" },
        ],
      };
    });

    return {
      kind: "stock_adjustment",
      documentId: adjustment?.id,
      eyebrow: "Stock Adjustment",
      listPath: "/inventory-app/stock?tab=adjustments",
      title: adjustment?.adjustment_number ?? "Adjustment",
      docNumber: adjustment?.adjustment_number,
      status: adjustment?.status,
      loading: isLoading,
      notFound: !isLoading && !!adjustmentId && !adjustment,
      meta: adjustment ? (
        <>
          <span>{fmtDate(adjustment.adjustment_date)}</span>
          <span className="capitalize">
            {adjustment.reason?.replace(/_/g, " ") || "No reason given"}
          </span>
        </>
      ) : undefined,
      detailFields: adjustment
        ? [
            { label: "Date", value: fmtDate(adjustment.adjustment_date) },
            {
              label: "Reason",
              value: adjustment.reason?.replace(/_/g, " ") || "—",
            },
            {
              label: "Created by",
              value: creator?.full_name || creator?.email || "—",
            },
            {
              label: "Approved by",
              value: approver
                ? `${approver.full_name || approver.email}${
                    adjustment.approved_at
                      ? ` · ${fmtDate(adjustment.approved_at)}`
                      : ""
                  }`
                : "—",
            },
            { label: "Notes", value: adjustment.notes || "—" },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No items on this adjustment.",
    };
  }, [adjustment, adjustmentId, approver, creator, isLoading]);

  return (
    <PeekScaffold
      {...view}
      open={open}
      onOpenChange={onOpenChange}
      fullPageHref={
        adjustmentId
          ? `/inventory-app/stock?tab=adjustments&selected=${adjustmentId}`
          : undefined
      }
    />
  );
}

export default AdjustmentPeekSheet;
