/**
 * Lots — index of `stock_lots` for the active business.
 *
 * Phase G · Inventory Foundation Audit. Read-only surface. Filter by
 * product, supplier, and expiry window. Click a row to open the
 * genealogy detail page.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Search, Boxes } from "lucide-react";
import { format, differenceInDays } from "date-fns";

interface LotRow {
  id: string;
  lot_number: string;
  expiry_date: string | null;
  manufacture_date: string | null;
  serial_number: string | null;
  is_active: boolean;
  created_at: string;
  goods_receipt_id: string | null;
  product?: { id: string; name: string; sku: string | null } | null;
  supplier?: { id: string; name: string } | null;
}

function expiryBadge(iso: string | null) {
  if (!iso) return null;
  const days = differenceInDays(new Date(iso), new Date());
  if (days < 0) return <Badge variant="destructive">Expired</Badge>;
  if (days <= 30) return <Badge variant="outline">Expires {days}d</Badge>;
  return <Badge variant="secondary">{days}d left</Badge>;
}

export default function Lots() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();

  const [rows, setRows] = useState<LotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("stock_lots")
      .select(
        "id, lot_number, expiry_date, manufacture_date, serial_number, is_active, created_at, goods_receipt_id, product:products(id, name, sku), supplier:contacts(id, name)",
      )
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      toast({ title: "Failed to load lots", description: error.message, variant: "destructive" });
      setRows([]);
    } else {
      setRows((data ?? []) as unknown as LotRow[]);
    }
    setLoading(false);
  }, [currentOrg?.id, currentBusiness?.id, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.lot_number.toLowerCase().includes(q) ||
        (r.product?.name ?? "").toLowerCase().includes(q) ||
        (r.product?.sku ?? "").toLowerCase().includes(q) ||
        (r.supplier?.name ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Lots &amp; Traceability</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Every batch of lot-tracked stock ever received. Click a lot to see its full genealogy — origin GRN, warehouse distribution, and every outbound movement.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search lot #, product, SKU, supplier..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
              <Boxes className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm">No lots yet.</p>
              <p className="text-xs mt-1">Lots are created automatically on Goods Receipt for lot-tracked products.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lot #</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Mfg</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/inventory-app/lots/${r.id}`)}
                  >
                    <TableCell className="font-mono text-xs font-medium">{r.lot_number}</TableCell>
                    <TableCell>{r.product?.name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.product?.sku ?? "—"}</TableCell>
                    <TableCell>{r.supplier?.name ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {r.manufacture_date ? format(new Date(r.manufacture_date), "dd MMM yyyy") : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.expiry_date ? format(new Date(r.expiry_date), "dd MMM yyyy") : "—"}
                    </TableCell>
                    <TableCell>{expiryBadge(r.expiry_date) ?? (r.is_active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Inactive</Badge>)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
