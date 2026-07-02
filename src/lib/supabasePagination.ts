import { supabase } from "@/integrations/supabase/client";

/**
 * Fetch all rows from a Supabase table, paginating past the 1000-row default limit.
 * Uses range-based pagination with configurable page size.
 */
export async function fetchAllRows<T = Record<string, any>>(
  table: string,
  select: string,
  filters: Array<{
    method: "eq" | "in" | "neq" | "is";
    column: string;
    value: any;
  }> = [],
  pageSize = 1000
): Promise<T[]> {
  const allRows: T[] = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    let query = (supabase as any)
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1);

    for (const filter of filters) {
      query = query[filter.method](filter.column, filter.value);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data || []) as T[];
    allRows.push(...rows);

    if (rows.length < pageSize) {
      hasMore = false;
    } else {
      from += pageSize;
    }
  }

  return allRows;
}
