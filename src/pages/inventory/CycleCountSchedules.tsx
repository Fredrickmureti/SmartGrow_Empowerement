/**
 * Cycle Count Schedules — recurring physical-count generator.
 *
 * D7 of the Physical Count enterprise hardening plan. Lets ops define
 * cadence-based cycle counts (daily/weekly/monthly, optionally scoped by
 * ABC class / category / product list) per warehouse. The
 * `generate_due_cycle_counts()` RPC materialises due schedules into draft
 * `physical_counts` rows, which then flow through the standard
 * freeze → count → submit → approve → post lifecycle.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ConfirmDeleteDialog } from "@/components/shared/ConfirmDeleteDialog";
import { DetailSheet, FieldGrid, FooterActionBar } from "@/design-system";
import { Plus, Pencil, Trash2, Play, CalendarClock } from "lucide-react";
import { format } from "date-fns";

type Cadence = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly";
type ScopeType = "warehouse" | "abc_class" | "category" | "product_list";

interface Schedule {
  id: string;
  organization_id: string;
  business_id: string | null;
  warehouse_id: string;
  name: string;
  cadence: Cadence;
  scope_type: ScopeType;
  abc_class: "A" | "B" | "C" | null;
  tolerance_pct: number | null;
  tolerance_value: number | null;
  auto_freeze: boolean;
  active: boolean;
  next_run_at: string;
  last_run_at: string | null;
}

interface FormState {
  name: string;
  warehouse_id: string;
  cadence: Cadence;
  scope_type: ScopeType;
  abc_class: "A" | "B" | "C" | "";
  tolerance_pct: string;
  tolerance_value: string;
  auto_freeze: boolean;
  active: boolean;
}

const EMPTY: FormState = {
  name: "",
  warehouse_id: "",
  cadence: "weekly",
  scope_type: "warehouse",
  abc_class: "",
  tolerance_pct: "",
  tolerance_value: "",
  auto_freeze: false,
  active: true,
};

export default function CycleCountSchedules() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const qc = useQueryClient();
  const { toast } = useToast();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);

  const enabled = !!orgId && !!bizId;

  const { data: warehouses = [] } = useQuery({
    queryKey: ["warehouses-for-cycle", orgId, bizId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("warehouses")
        .select("id, name")
        .eq("organization_id", orgId!)
        .eq("business_id", bizId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ["cycle-count-schedules", orgId, bizId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cycle_count_schedules" as never)
        .select("*")
        .eq("organization_id", orgId!)
        .order("next_run_at");
      if (error) throw error;
      return (data ?? []) as unknown as Schedule[];
    },
  });

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY, warehouse_id: warehouses[0]?.id ?? "" });
    setSheetOpen(true);
  };

  const openEdit = (s: Schedule) => {
    setEditing(s);
    setForm({
      name: s.name,
      warehouse_id: s.warehouse_id,
      cadence: s.cadence,
      scope_type: s.scope_type,
      abc_class: (s.abc_class ?? "") as FormState["abc_class"],
      tolerance_pct: s.tolerance_pct?.toString() ?? "",
      tolerance_value: s.tolerance_value?.toString() ?? "",
      auto_freeze: s.auto_freeze,
      active: s.active,
    });
    setSheetOpen(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!orgId || !bizId) throw new Error("Missing org/business");
      if (!form.name.trim()) throw new Error("Name required");
      if (!form.warehouse_id) throw new Error("Warehouse required");
      const payload = {
        organization_id: orgId,
        business_id: bizId,
        warehouse_id: form.warehouse_id,
        name: form.name.trim(),
        cadence: form.cadence,
        scope_type: form.scope_type,
        abc_class: form.abc_class || null,
        tolerance_pct: form.tolerance_pct ? Number(form.tolerance_pct) : null,
        tolerance_value: form.tolerance_value ? Number(form.tolerance_value) : null,
        auto_freeze: form.auto_freeze,
        active: form.active,
      };
      if (editing) {
        const { error } = await supabase
          .from("cycle_count_schedules" as never)
          .update(payload as never)
          .eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("cycle_count_schedules" as never)
          .insert(payload as never);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast({ title: editing ? "Schedule updated" : "Schedule created" });
      setSheetOpen(false);
      qc.invalidateQueries({ queryKey: ["cycle-count-schedules"] });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("cycle_count_schedules" as never).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Schedule deleted" });
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["cycle-count-schedules"] });
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const { data, error } = await (supabase.rpc as unknown as (n: string) => Promise<{ data: unknown; error: unknown }>)("generate_due_cycle_counts");
      if (error) throw error;
      return (data ?? []) as { schedule_id: string; count_id: string; count_number: string }[];
    },
    onSuccess: (rows) => {
      toast({
        title: rows.length ? `${rows.length} draft count(s) generated` : "Nothing due",
      });
      qc.invalidateQueries({ queryKey: ["cycle-count-schedules"] });
    },
    onError: (e: Error) => toast({ title: "Run failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <CalendarClock className="h-6 w-6" /> Cycle count schedules
          </h1>
          <p className="text-sm text-muted-foreground">
            Recurring cycle counts feed draft physical-counts into your workspace on schedule.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            <Play className="mr-2 h-4 w-4" /> Run due now
          </Button>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> New schedule
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Schedules</CardTitle>
          <CardDescription>
            Due schedules generate a draft `physical_counts` row via `generate_due_cycle_counts()`.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
          ) : schedules.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No cycle-count schedules yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Cadence</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => {
                  const wh = warehouses.find((w) => w.id === s.warehouse_id);
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell>{wh?.name ?? "—"}</TableCell>
                      <TableCell><Badge variant="secondary">{s.cadence}</Badge></TableCell>
                      <TableCell>
                        <span className="text-xs">
                          {s.scope_type}
                          {s.abc_class ? ` · ${s.abc_class}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {format(new Date(s.next_run_at), "PP p")}
                      </TableCell>
                      <TableCell className="text-xs">
                        {s.last_run_at ? format(new Date(s.last_run_at), "PP p") : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={s.active ? "default" : "outline"}>
                          {s.active ? "Active" : "Paused"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button size="icon" variant="ghost" onClick={() => openEdit(s)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(s)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <DetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={editing ? "Edit schedule" : "New cycle-count schedule"}
        description="Draft counts are generated when next_run_at is reached and Run due now is invoked (or by pg_cron)."
        footer={
          <FooterActionBar
            anchor="sheet"
            trailing={
              <>
                <Button variant="outline" onClick={() => setSheetOpen(false)}>Cancel</Button>
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  {editing ? "Save" : "Create"}
                </Button>
              </>
            }
          />
        }
      >
        <FieldGrid columns={2}>
          <div className="col-span-2">
            <Label>Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Weekly A-class count — Main"
            />
          </div>
          <div>
            <Label>Warehouse</Label>
            <Select value={form.warehouse_id} onValueChange={(v) => setForm({ ...form, warehouse_id: v })}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Cadence</Label>
            <Select value={form.cadence} onValueChange={(v) => setForm({ ...form, cadence: v as Cadence })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Bi-weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Scope</Label>
            <Select value={form.scope_type} onValueChange={(v) => setForm({ ...form, scope_type: v as ScopeType })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="warehouse">Whole warehouse</SelectItem>
                <SelectItem value="abc_class">ABC class</SelectItem>
                <SelectItem value="category">Category</SelectItem>
                <SelectItem value="product_list">Product list</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.scope_type === "abc_class" && (
            <div>
              <Label>ABC class</Label>
              <Select
                value={form.abc_class || undefined}
                onValueChange={(v) => setForm({ ...form, abc_class: v as FormState["abc_class"] })}
              >
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">A</SelectItem>
                  <SelectItem value="B">B</SelectItem>
                  <SelectItem value="C">C</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Tolerance %</Label>
            <Input
              type="number"
              step="0.01"
              value={form.tolerance_pct}
              onChange={(e) => setForm({ ...form, tolerance_pct: e.target.value })}
              placeholder="e.g. 2"
            />
          </div>
          <div>
            <Label>Tolerance value</Label>
            <Input
              type="number"
              step="0.01"
              value={form.tolerance_value}
              onChange={(e) => setForm({ ...form, tolerance_value: e.target.value })}
              placeholder="e.g. 5000"
            />
          </div>
          <div className="flex items-center justify-between col-span-2 rounded border p-3">
            <div>
              <Label>Auto-freeze on generation</Label>
              <p className="text-xs text-muted-foreground">Skip draft — immediately move the generated count to counting.</p>
            </div>
            <Switch checked={form.auto_freeze} onCheckedChange={(v) => setForm({ ...form, auto_freeze: v })} />
          </div>
          <div className="flex items-center justify-between col-span-2 rounded border p-3">
            <div>
              <Label>Active</Label>
              <p className="text-xs text-muted-foreground">Inactive schedules are skipped by the generator.</p>
            </div>
            <Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />
          </div>
        </FieldGrid>
      </DetailSheet>

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete schedule?"
        description={`"${deleteTarget?.name}" will stop generating cycle counts.`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        isLoading={remove.isPending}
      />
    </div>
  );
}
