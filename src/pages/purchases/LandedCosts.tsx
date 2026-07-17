/**
 * LandedCosts — management surface for landed-cost bills (ADR 0077).
 *
 * A landed-cost bill captures freight, duty, insurance or other
 * non-vendor costs that must be absorbed into a set of GRN receipts.
 * This page lists open landed-cost bills, exposes the "Allocate" and
 * "Post" actions, and links back to the source vendor bill.
 *
 * All server-side work runs through `allocate_landed_cost_bill` — the
 * client never touches `landed_cost_allocations` directly.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ArrowUpRight, Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { useAuth } from "@/hooks/useAuth";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";

interface LandedCostBill {
  id: string;
  bill_id: string | null;
  cost_type: string;
  description: string | null;
  currency: string;
  total_amount: number;
  allocation_basis: string;
  status: string;
  posted_at: string | null;
  created_at: string;
  vendor_id: string | null;
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  allocated: "bg-blue-100 text-blue-800",
  posted: "bg-green-100 text-green-800",
  reversed: "bg-red-100 text-red-800",
};

export default function LandedCosts() {
  const { user } = useAuth();
  const { activeBusinessId } = useActiveBusiness();
  const { formatCurrency } = useCurrency();
  const [rows, setRows] = useState<LandedCostBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    if (!activeBusinessId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("landed_cost_bills")
      .select(
        "id, bill_id, cost_type, description, currency, total_amount, allocation_basis, status, posted_at, created_at, vendor_id",
      )
      .eq("business_id", activeBusinessId)
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    else setRows((data ?? []) as LandedCostBill[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBusinessId]);

  const handleAllocate = async (id: string) => {
    setBusyId(id);
    try {
      const { data, error } = await supabase.rpc("allocate_landed_cost_bill", {
        p_bill_id: id,
        p_goods_receipt_ids: null,
      });
      if (error) throw error;
      toast.success(
        `Allocated across ${typeof data === "number" ? data : 0} receipt line(s).`,
      );
      await load();
    } catch (err) {
      toast.error(`Allocation failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handlePost = async (id: string) => {
    if (!user?.id) return;
    setBusyId(id);
    try {
      // Posting simply flips the header status; the allocation rows
      // already exist. Downstream cost-layer application happens via
      // stock_movements when the linked GRN posts.
      const { error } = await supabase
        .from("landed_cost_bills")
        .update({ status: "posted", posted_at: new Date().toISOString(), posted_by: user.id })
        .eq("id", id);
      if (error) throw error;
      toast.success("Landed cost posted.");
      await load();
    } catch (err) {
      toast.error(`Post failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Layers className="h-6 w-6" />
            Landed costs
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Distribute freight, duty and insurance across goods receipts
            so inventory absorbs true landed cost.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open landed-cost bills</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No landed-cost bills yet. Convert a freight / customs vendor
              bill into a landed cost from the Bill record page.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-4">Cost type</th>
                    <th className="py-2 pr-4">Description</th>
                    <th className="py-2 pr-4">Basis</th>
                    <th className="py-2 pr-4 text-right">Amount</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Source bill</th>
                    <th className="py-2 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 capitalize">{r.cost_type}</td>
                      <td className="py-2 pr-4">{r.description ?? "—"}</td>
                      <td className="py-2 pr-4 capitalize">{r.allocation_basis}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatCurrency(r.total_amount)} {r.currency}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className={STATUS_TONE[r.status] ?? ""}>
                          {r.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4">
                        {r.bill_id ? (
                          <Link
                            to={`/purchases/bills/${r.bill_id}`}
                            className="text-primary inline-flex items-center gap-1 hover:underline"
                          >
                            Open <ArrowUpRight className="h-3 w-3" />
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right space-x-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === r.id || r.status === "posted"}
                          onClick={() => handleAllocate(r.id)}
                        >
                          Allocate
                        </Button>
                        <Button
                          size="sm"
                          disabled={busyId === r.id || r.status !== "allocated"}
                          onClick={() => handlePost(r.id)}
                        >
                          Post
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
