/**
 * QCQueue — list of open / in-review QC inspections with quick filters.
 *
 * Reads only. Row click routes into `QCInspectionDetail` which drives
 * the sanctioned RPCs (`record_qc_check`, `accept_qc_inspection`,
 * `reject_qc_inspection`, `cancel_qc_inspection`).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ShieldCheck } from "lucide-react";

interface Row {
  id: string;
  warehouse_id: string;
  source_doc_type: string;
  product_id: string | null;
  quantity: number;
  state: string;
  accepted_qty: number;
  rejected_qty: number;
  disposition: string | null;
  created_at: string;
  products?: { name: string | null; sku: string | null } | null;
  warehouses?: { name: string | null; code: string | null } | null;
}

const STATE_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  open: "default",
  in_review: "default",
  accepted: "secondary",
  partially_accepted: "secondary",
  rejected: "destructive",
  cancelled: "outline",
};

export default function QCQueue() {
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<string>("active");

  const { data, isLoading } = useQuery({
    queryKey: ["wms-qc-inspections", stateFilter],
    queryFn: async () => {
      let q = supabase
        .from("wms_qc_inspections")
        .select("id, warehouse_id, source_doc_type, product_id, quantity, state, accepted_qty, rejected_qty, disposition, created_at, products(name, sku), warehouses(name, code)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (stateFilter === "active") q = q.in("state", ["open", "in_review"]);
      else if (stateFilter !== "all") q = q.eq("state", stateFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });

  const rows = useMemo(() => {
    const list = data ?? [];
    if (!search) return list;
    const s = search.toLowerCase();
    return list.filter((r) =>
      (r.products?.name ?? "").toLowerCase().includes(s) ||
      (r.products?.sku ?? "").toLowerCase().includes(s) ||
      (r.warehouses?.name ?? "").toLowerCase().includes(s),
    );
  }, [data, search]);

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="Quality control"
        description="Inspect inbound receipts and returns before stock is released."
      />
      <PageBody>
        <Section>
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <Input placeholder="Search product / warehouse…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
            <select className="border rounded px-2 py-1 bg-background" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="active">Active (open + in review)</option>
              <option value="open">Open</option>
              <option value="in_review">In review</option>
              <option value="accepted">Accepted</option>
              <option value="partially_accepted">Partially accepted</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All</option>
            </select>
          </div>
          {isLoading ? (
            <LoadingState />
          ) : rows.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No inspections match.</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="p-0 divide-y">
                {rows.map((r) => (
                  <Link key={r.id} to={`/warehouse-app/qc/${r.id}`} className="flex items-center justify-between gap-3 p-3 hover:bg-muted">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {r.products?.name ?? "Unknown product"}
                        {r.products?.sku ? <span className="text-muted-foreground"> · {r.products.sku}</span> : null}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {r.warehouses?.name ?? "—"} · qty {r.quantity} · {r.source_doc_type.replace("_", " ")} · {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {r.disposition && <Badge variant="outline">{r.disposition.replace(/_/g, " ")}</Badge>}
                      <Badge variant={STATE_TONE[r.state] ?? "default"}>{r.state.replace("_", " ")}</Badge>
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </Section>
      </PageBody>
    </>
  );
}