/**
 * LicensePlates — WMS License Plate Number (LPN) registry (ADR 0079, Phase 1).
 *
 * A license plate is a handling unit (pallet / carton / tote / other) that
 * carries stock through the warehouse. Operations address the plate rather
 * than enumerating contents. Movement/seal events are emitted by DB
 * triggers onto `business_event_outbox`.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { PackageOpen, Plus, Search } from "lucide-react";

type LpnType = "pallet" | "carton" | "tote" | "other";
type LpnStatus = "open" | "sealed" | "shipped" | "retired";

interface LpnRow {
  id: string;
  code: string;
  lpn_type: LpnType;
  status: LpnStatus;
  parent_lpn_id: string | null;
  current_location_id: string | null;
  warehouse_id: string;
  sealed_at: string | null;
  created_at: string;
  stock_locations?: { code: string; name: string } | null;
}

function randomCode(): string {
  const yy = new Date().getFullYear().toString().slice(-2);
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LPN-${yy}${rnd}`;
}

const STATUS_TONE: Record<LpnStatus, "success" | "warning" | "info" | "neutral"> = {
  open: "info",
  sealed: "warning",
  shipped: "success",
  retired: "neutral",
};

export default function LicensePlates() {
  const qc = useQueryClient();
  const { warehouses } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();

  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-lpns", currentBusiness?.id, warehouseFilter, typeFilter, statusFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_license_plates")
        .select("id, code, lpn_type, status, parent_lpn_id, current_location_id, warehouse_id, sealed_at, created_at, stock_locations:current_location_id(code, name)")
        .eq("business_id", currentBusiness!.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      if (typeFilter !== "all") q = q.eq("lpn_type", typeFilter as LpnType);
      if (statusFilter !== "all") q = q.eq("status", statusFilter as LpnStatus);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as LpnRow[];
    },
  });

  const filtered = useMemo(() => {
    if (!rows) return [];
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => r.code.toLowerCase().includes(s));
  }, [rows, search]);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    code: randomCode(),
    lpn_type: "pallet" as LpnType,
    warehouse_id: "",
    parent_lpn_id: "",
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id || !currentOrg?.id) throw new Error("No active organization");
      if (!form.warehouse_id) throw new Error("Choose a warehouse");
      const wh = warehouses.find((w) => w.id === form.warehouse_id);
      const { error } = await supabase.from("wms_license_plates").insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: wh?.branch_id ?? null,
        warehouse_id: form.warehouse_id,
        code: form.code.trim(),
        lpn_type: form.lpn_type,
        parent_lpn_id: form.parent_lpn_id || null,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("License plate created");
      setCreateOpen(false);
      setForm({ code: randomCode(), lpn_type: "pallet", warehouse_id: "", parent_lpn_id: "" });
      qc.invalidateQueries({ queryKey: ["wms-lpns"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to create"),
  });

  return (
    <>
      <PageHeader
        title="License plates"
        description="Handling units (pallet, carton, tote) tracked through the warehouse. Movements address the plate, not its contents."
        actions={
          <Button onClick={() => { setForm((f) => ({ ...f, code: randomCode() })); setCreateOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" /> New plate
          </Button>
        }
      />
      <PageBody>
        <Section>
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Search by code"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                  <SelectTrigger className="w-[180px]"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All warehouses</SelectItem>
                    {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-[140px]"><SelectValue placeholder="Type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="pallet">Pallet</SelectItem>
                    <SelectItem value="carton">Carton</SelectItem>
                    <SelectItem value="tote">Tote</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any status</SelectItem>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="sealed">Sealed</SelectItem>
                    <SelectItem value="shipped">Shipped</SelectItem>
                    <SelectItem value="retired">Retired</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isLoading ? (
                <LoadingState />
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={PackageOpen}
                  title="No license plates yet"
                  description="Create your first plate to start tracking pallets, cartons, or totes through the warehouse."
                  action={
                    <Button onClick={() => { setForm((f) => ({ ...f, code: randomCode() })); setCreateOpen(true); }}>
                      <Plus className="mr-2 h-4 w-4" /> New plate
                    </Button>
                  }
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Current location</TableHead>
                      <TableHead>Sealed</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Link className="font-mono text-sm underline underline-offset-2" to={`/warehouse-app/plates/${r.id}`}>
                            {r.code}
                          </Link>
                        </TableCell>
                        <TableCell className="capitalize">{r.lpn_type}</TableCell>
                        <TableCell><StatusBadge tone={STATUS_TONE[r.status]}>{r.status}</StatusBadge></TableCell>
                        <TableCell className="text-sm">
                          {r.stock_locations
                            ? <span>{r.stock_locations.code} <span className="text-muted-foreground">· {r.stock_locations.name}</span></span>
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {r.sealed_at ? new Date(r.sealed_at).toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(r.created_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </Section>
      </PageBody>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New license plate</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Code</Label>
              <div className="flex gap-2">
                <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="font-mono" />
                <Button variant="outline" type="button" onClick={() => setForm({ ...form, code: randomCode() })}>Regenerate</Button>
              </div>
            </div>
            <div>
              <Label>Type</Label>
              <Select value={form.lpn_type} onValueChange={(v) => setForm({ ...form, lpn_type: v as LpnType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pallet">Pallet</SelectItem>
                  <SelectItem value="carton">Carton</SelectItem>
                  <SelectItem value="tote">Tote</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Warehouse</Label>
              <Select value={form.warehouse_id} onValueChange={(v) => setForm({ ...form, warehouse_id: v })}>
                <SelectTrigger><SelectValue placeholder="Choose warehouse" /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Parent plate (optional)</Label>
              <Select
                value={form.parent_lpn_id || "none"}
                onValueChange={(v) => setForm({ ...form, parent_lpn_id: v === "none" ? "" : v })}
              >
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {(rows ?? []).filter((r) => r.status !== "retired").map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
