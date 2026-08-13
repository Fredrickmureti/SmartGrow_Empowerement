/**
 * LandedCosts — interim list surface for the rebuilt landed-cost voucher domain.
 *
 * The legacy "landed cost bill" tables and their browser-side status writes
 * have been retired. This page reads the new `landed_cost_vouchers` model
 * read-only; allocation and posting are server-side RPCs wired up in the
 * dedicated workspace that replaces this shell.
 */

import { useEffect, useState } from "react";
import { Layers } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { useBusinesses } from "@/hooks/useBusinesses";

interface LandedCostVoucherRow {
  id: string;
  voucher_number: string | null;
  status: string;
  voucher_date: string;
  shipment_reference: string | null;
  currency: string;
  total_amount: number;
  capitalized_amount: number;
  expensed_amount: number;
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_approval: "bg-amber-100 text-amber-800",
  allocated: "bg-blue-100 text-blue-800",
  posted: "bg-green-100 text-green-800",
  reversed: "bg-red-100 text-red-800",
  cancelled: "bg-muted text-muted-foreground",
};

export default function LandedCosts() {
  const { currentBusiness } = useBusinesses();
  const activeBusinessId = currentBusiness?.id ?? null;
  const { formatCurrency } = useCurrency();
  const [rows, setRows] = useState<LandedCostVoucherRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!activeBusinessId) return;
      setLoading(true);
      const { data } = await supabase
        .from("landed_cost_vouchers")
        .select(
          "id, voucher_number, status, voucher_date, shipment_reference, currency, total_amount, capitalized_amount, expensed_amount",
        )
        .eq("business_id", activeBusinessId)
        .order("voucher_date", { ascending: false })
        .limit(100);
      if (!cancelled) {
        setRows((data ?? []) as LandedCostVoucherRow[]);
        setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeBusinessId]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Layers className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold">Landed Costs</h1>
          <p className="text-sm text-muted-foreground">
            Freight, duty, insurance and handling capitalised onto received stock.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vouchers</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No landed cost vouchers yet.</p>
          ) : (
            <div className="divide-y">
              {rows.map((row) => (
                <div key={row.id} className="flex items-center justify-between py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.voucher_number ?? "—"}</span>
                      <Badge className={STATUS_TONE[row.status] ?? ""} variant="secondary">
                        {row.status.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {row.shipment_reference ?? "No shipment reference"} · {row.voucher_date}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="font-medium">{formatCurrency(row.total_amount)}</div>
                    <p className="text-xs text-muted-foreground">
                      Capitalised {formatCurrency(row.capitalized_amount)} · Expensed{" "}
                      {formatCurrency(row.expensed_amount)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
