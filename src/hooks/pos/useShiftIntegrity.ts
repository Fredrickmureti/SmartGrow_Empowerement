/**
 * Shift integrity reconciliation hook (MC-2 of POS audit).
 *
 * Detects drift between the running counter `pos_shifts.total_sales` and the
 * authoritative `SUM(pos_transactions.total)` for that shift. Any non-zero
 * delta indicates a trigger or manual-update bug worth investigating before
 * GL posting at session close.
 *
 * Scoped strictly by organization + business; the underlying tables also
 * carry RLS, so a branch-restricted user only sees shifts they can read.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";

export interface ShiftIntegrityRow {
  shift_id: string;
  shift_number: string;
  register_name: string | null;
  branch_id: string | null;
  opened_at: string;
  closed_at: string | null;
  status: string;
  recorded_total: number;
  computed_total: number;
  delta: number;
  transaction_count: number;
}

interface UseShiftIntegrityArgs {
  dateFrom: string;
  dateTo: string;
  branchId?: string;
}

export function useShiftIntegrity({ dateFrom, dateTo, branchId }: UseShiftIntegrityArgs) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["pos-shift-integrity", currentOrg?.id, currentBusiness?.id, dateFrom, dateTo, branchId],
    queryFn: async (): Promise<ShiftIntegrityRow[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      // Pull shifts in window. business_id is NOT NULL on pos_shifts post-audit,
      // so no leak fallback is needed.
      let shiftQuery = supabase
        .from("pos_shifts")
        .select(`
          id,
          shift_number,
          branch_id,
          opened_at,
          closed_at,
          status,
          total_sales,
          register:pos_registers(register_name)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .gte("opened_at", dateFrom)
        .lte("opened_at", `${dateTo}T23:59:59`)
        .order("opened_at", { ascending: false })
        .limit(500);

      if (branchId && branchId !== "all") {
        shiftQuery = shiftQuery.eq("branch_id", branchId);
      }

      const { data: shifts, error: shiftErr } = await shiftQuery;
      if (shiftErr) throw shiftErr;
      if (!shifts || shifts.length === 0) return [];

      const shiftIds = shifts.map((s) => s.id);

      // Authoritative totals from completed transactions only — voided/suspended
      // tickets must not count toward the shift total.
      const { data: txns, error: txnErr } = await supabase
        .from("pos_transactions")
        .select("shift_id, total, status")
        .in("shift_id", shiftIds)
        .eq("status", "completed");
      if (txnErr) throw txnErr;

      const computed = new Map<string, { total: number; count: number }>();
      for (const t of txns ?? []) {
        const slot = computed.get(t.shift_id) ?? { total: 0, count: 0 };
        slot.total += Number(t.total ?? 0);
        slot.count += 1;
        computed.set(t.shift_id, slot);
      }

      return shifts.map((s) => {
        const c = computed.get(s.id) ?? { total: 0, count: 0 };
        const recorded = Number(s.total_sales ?? 0);
        return {
          shift_id: s.id,
          shift_number: s.shift_number,
          register_name: (s.register as { register_name: string } | null)?.register_name ?? null,
          branch_id: s.branch_id,
          opened_at: s.opened_at,
          closed_at: s.closed_at,
          status: s.status,
          recorded_total: recorded,
          computed_total: c.total,
          delta: Number((recorded - c.total).toFixed(2)),
          transaction_count: c.count,
        };
      });
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });
}
