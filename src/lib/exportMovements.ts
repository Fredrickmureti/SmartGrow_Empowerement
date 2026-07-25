import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";

export async function exportMovementsToCSV(
  organizationId: string,
  businessId: string | null,
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    movementType?: string;
    warehouseId?: string;
  }
) {
  let query = supabase
    .from("stock_movements")
    .select("*, products(name, sku), warehouses(name)")
    .eq("organization_id", organizationId)
    .order("movement_date", { ascending: false });

  query = query.eq("business_id", businessId);
  if (filters?.movementType && filters.movementType !== "all") {
    query = query.eq("movement_type", filters.movementType);
  }
  if (filters?.warehouseId) query = query.eq("warehouse_id", filters.warehouseId);
  if (filters?.dateFrom) query = query.gte("movement_date", filters.dateFrom);
  if (filters?.dateTo) query = query.lte("movement_date", filters.dateTo + "T23:59:59");

  // Fetch in pages to get all data
  const allRows: any[] = [];
  let from = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    allRows.push(...(data || []));
    hasMore = (data || []).length === pageSize;
    from += pageSize;
  }

  // Build CSV
  const headers = ["Date", "Product", "SKU", "Type", "Quantity", "Unit Cost", "Total Value", "Warehouse", "Reference Type", "Notes"];
  const rows = allRows.map((m) => [
    format(new Date(m.movement_date), "yyyy-MM-dd HH:mm"),
    m.products?.name || "",
    m.products?.sku || "",
    m.movement_type,
    m.quantity,
    m.unit_cost || "",
    m.unit_cost ? (Math.abs(m.quantity) * m.unit_cost).toFixed(2) : "",
    m.warehouses?.name || "Default",
    m.reference_type || "",
    (m.notes || "").replace(/"/g, '""'),
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map((r) => r.map((v: any) => `"${v}"`).join(",")),
  ].join("\r\n");

  downloadCsv(`stock-movements-${format(new Date(), "yyyy-MM-dd")}.csv`, csvContent);

  return allRows.length;
}
