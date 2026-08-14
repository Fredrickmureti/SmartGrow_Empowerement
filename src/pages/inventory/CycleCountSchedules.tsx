/**
 * Cycle Counting page.
 *
 * All copy on this page is written for an inventory manager — no table
 * names, no function names, no column names. Enforced by
 * `src/__tests__/architecture.cycle-count-copy.test.ts`.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";

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
import { DetailSheet, FieldGrid, FieldCell, FooterActionBar } from "@/design-system";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
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

const CADENCE_LABEL: Record<Cadence, string> = {
  daily: "Every day",
  weekly: "Every week",
  biweekly: "Every two weeks",
  monthly: "Every month",
  quarterly: "Every quarter",
};

const SCOPE_LABEL: Record<ScopeType, string> = {
  warehouse: "The entire warehouse",
  abc_class: "Only A/B/C class items",
  category: "A specific product category",
  product_list: "A hand-picked product list",
};

const scopeSummary = (s: Schedule) => {
  if (s.scope_type === "abc_class") {
    return s.abc_class ? `Class ${s.abc_class} items` : "A/B/C class items";
  }
  return SCOPE_LABEL[s.scope_type];
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

  // Warehouses come from the shared inventory seam so this picker inherits the
  // platform rules for free: in-transit buckets excluded, inactive excluded,
  // branch scoped. Never query `warehouses` directly from a page.
  const { activeWarehouses: warehouses } = useWarehouses();

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ["cycle-count-schedules", orgId, bizId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cycle_count_schedules" as never)
        .select("*")
        .eq("organization_id", orgId!)
        .eq("business_id", bizId!)
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
      if (!orgId || !bizId) throw new Error("Please select an organization and business first.");
      if (!form.name.trim()) throw new Error("Give this schedule a name your team will recognise.");
      if (!form.warehouse_id) throw new Error("Choose which warehouse this schedule applies to.");
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
    onError: (e: Error) => toast({ title: "Could not save schedule", description: e.message, variant: "destructive" }),
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
    onError: (e: Error) => toast({ title: "Could not delete schedule", description: e.message, variant: "destructive" }),
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const { data, error } = await (supabase.rpc as unknown as (n: string) => Promise<{ data: unknown; error: unknown }>)("generate_due_cycle_counts");
      if (error) throw error;
      return (data ?? []) as { schedule_id: string; count_id: string; count_number: string }[];
    },
    onSuccess: (rows) => {
      toast({
        title: rows.length
          ? `${rows.length} count worksheet${rows.length === 1 ? "" : "s"} generated`
          : "Nothing due right now",
        description: rows.length
          ? "New worksheets are ready in Physical Counts."
          : "All active schedules are up to date — check back later.",
      });
      qc.invalidateQueries({ queryKey: ["cycle-count-schedules"] });
    },
    onError: (e: Error) => toast({ title: "Could not generate worksheets", description: e.message, variant: "destructive" }),
  });

  return (
    <TooltipProvider>
      <div className="space-y-4 sm:space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold flex items-center gap-2">
              <CalendarClock className="h-5 w-5 sm:h-6 sm:w-6 shrink-0" /> Cycle counting
            </h1>
            <p className="text-sm text-muted-foreground max-w-2xl mt-1">
              Automatically schedule small, recurring stock counts so you never
              rely on a single year-end count. Each schedule picks a warehouse
              and a rhythm, and drops a ready-to-count worksheet into Physical
              Counts on its due date.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 sm:shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" onClick={() => runNow.mutate()} disabled={runNow.isPending} className="w-full sm:w-auto">
                  <Play className="mr-2 h-4 w-4" /> Run now
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Checks every active schedule and creates today's count
                worksheets immediately, instead of waiting for the overnight
                run.
              </TooltipContent>
            </Tooltip>
            <Button onClick={openCreate} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" /> New schedule
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Schedules</CardTitle>
            <CardDescription>
              Schedules run automatically overnight. Use <em>Run now</em> to
              generate today's worksheets on demand.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
            ) : schedules.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center max-w-md mx-auto">
                No cycle counts scheduled yet. Create a schedule to have the
                system automatically prepare count worksheets on a rhythm —
                for example, count your A-class items every week and
                everything else every quarter.
              </div>
            ) : (
              <div className="-mx-6 overflow-x-auto sm:mx-0">
                <div className="min-w-[900px] px-6 sm:min-w-0 sm:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Warehouse</TableHead>
                        <TableHead>How often</TableHead>
                        <TableHead>What to count</TableHead>
                        <TableHead>Next count due</TableHead>
                        <TableHead>Last generated</TableHead>
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
                            <TableCell>
                              {wh ? (
                                wh.name
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant="destructive">Needs repointing</Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    This schedule points at a place that cannot be
                                    counted — stock in transit, a closed location, or
                                    one belonging to another branch. Edit it and choose
                                    a countable warehouse.
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </TableCell>

                            <TableCell><Badge variant="secondary">{CADENCE_LABEL[s.cadence]}</Badge></TableCell>
                            <TableCell><span className="text-xs">{scopeSummary(s)}</span></TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {format(new Date(s.next_run_at), "PP p")}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {s.last_run_at ? format(new Date(s.last_run_at), "PP p") : "—"}
                            </TableCell>
                            <TableCell>
                              <Badge variant={s.active ? "default" : "outline"}>
                                {s.active ? "Active" : "Paused"}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                <Button size="icon" variant="ghost" onClick={() => openEdit(s)} aria-label="Edit">
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(s)} aria-label="Delete">
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <DetailSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          title={editing ? "Edit cycle count schedule" : "New cycle count schedule"}
          description="Cycle counting means counting a slice of your stock on a regular rhythm instead of shutting the warehouse for a full count. Configure how often to count, what to count, and how large a variance is acceptable before requiring investigation."
          footer={
            <FooterActionBar
              anchor="sheet"
              trailing={
                <>
                  <Button variant="outline" onClick={() => setSheetOpen(false)}>Cancel</Button>
                  <Button onClick={() => save.mutate()} disabled={save.isPending}>
                    {editing ? "Save changes" : "Create schedule"}
                  </Button>
                </>
              }
            />
          }
        >
          <FieldGrid columns={2}>
            <FieldCell span="full">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Weekly A-class — Main warehouse"
              />
              <p className="text-xs text-muted-foreground mt-1">
                A label your team will recognise on the Physical Counts list.
              </p>
            </FieldCell>

            <FieldCell>
              <Label>Warehouse</Label>
              <Select value={form.warehouse_id} onValueChange={(v) => setForm({ ...form, warehouse_id: v })}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select a warehouse" /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Which warehouse this rotation applies to.
              </p>
            </FieldCell>

            <FieldCell>
              <Label>How often</Label>
              <Select value={form.cadence} onValueChange={(v) => setForm({ ...form, cadence: v as Cadence })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Every day</SelectItem>
                  <SelectItem value="weekly">Every week</SelectItem>
                  <SelectItem value="biweekly">Every two weeks</SelectItem>
                  <SelectItem value="monthly">Every month</SelectItem>
                  <SelectItem value="quarterly">Every quarter</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                How frequently the system should generate a new count worksheet.
              </p>
            </FieldCell>

            <FieldCell>
              <Label>What to count</Label>
              <Select value={form.scope_type} onValueChange={(v) => setForm({ ...form, scope_type: v as ScopeType })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="warehouse">The entire warehouse</SelectItem>
                  <SelectItem value="abc_class">Only A/B/C class items</SelectItem>
                  <SelectItem value="category">A specific product category</SelectItem>
                  <SelectItem value="product_list">A hand-picked product list</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Which stock the worksheet should include.
              </p>
            </FieldCell>

            {form.scope_type === "abc_class" && (
              <FieldCell>
                <Label>ABC class</Label>
                <Select
                  value={form.abc_class || undefined}
                  onValueChange={(v) => setForm({ ...form, abc_class: v as FormState["abc_class"] })}
                >
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">A — highest value / fastest movers</SelectItem>
                    <SelectItem value="B">B — mid-tier</SelectItem>
                    <SelectItem value="C">C — long-tail / low value</SelectItem>
                  </SelectContent>
                </Select>
              </FieldCell>
            )}

            <FieldCell>
              <Label>Tolerance %</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={form.tolerance_pct}
                onChange={(e) => setForm({ ...form, tolerance_pct: e.target.value })}
                placeholder="e.g. 2"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Variances smaller than this percentage are auto-accepted.
                Larger variances are flagged for review before posting.
              </p>
            </FieldCell>

            <FieldCell>
              <Label>Tolerance amount</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={form.tolerance_value}
                onChange={(e) => setForm({ ...form, tolerance_value: e.target.value })}
                placeholder="e.g. 5,000"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Same idea, but as a money amount. Use whichever suits the
                products in scope.
              </p>
            </FieldCell>

            <FieldCell span="full">
              <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0 sm:pr-4">
                  <Label>Lock stock automatically when the worksheet is generated</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    When on, the worksheet skips <em>Draft</em> and locks stock
                    immediately so counters can start straight away. Leave off
                    if you want a supervisor to review before locking stock.
                  </p>
                </div>
                <Switch
                  checked={form.auto_freeze}
                  onCheckedChange={(v) => setForm({ ...form, auto_freeze: v })}
                  className="self-start sm:self-center shrink-0"
                />
              </div>
            </FieldCell>

            <FieldCell span="full">
              <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0 sm:pr-4">
                  <Label>Active</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Paused schedules stop generating new count worksheets.
                  </p>
                </div>
                <Switch
                  checked={form.active}
                  onCheckedChange={(v) => setForm({ ...form, active: v })}
                  className="self-start sm:self-center shrink-0"
                />
              </div>
            </FieldCell>
          </FieldGrid>
        </DetailSheet>

        <ConfirmDeleteDialog
          open={!!deleteTarget}
          onOpenChange={(o) => !o && setDeleteTarget(null)}
          title="Delete this schedule?"
          description={`"${deleteTarget?.name}" will stop generating new count worksheets. Existing worksheets already in Physical Counts are not affected.`}
          onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
          isLoading={remove.isPending}
        />
      </div>
    </TooltipProvider>
  );
}
