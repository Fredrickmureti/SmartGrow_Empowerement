/**
 * StandardsPanel — engineered labour standards with real dimensions.
 *
 * A flat "seconds per unit" is not an engineered standard. Real standards
 * vary by warehouse, zone, product category and equipment, and split
 * fixed setup time from variable handling and travel time. The most
 * specific active standard wins (resolved server-side by
 * `wms_resolve_labour_standard`), so a blank dimension means "applies
 * everywhere" — the fallback, not the rule.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { labourErrorMessage } from "./labourErrors";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingState } from "@/design-system";
import { Plus, Trash2 } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { WMS_TASK_TYPES, LABOUR_KEYS, type WmsTaskType } from "./useLabourOperators";

const ANY = "__any";

interface StandardRow {
  id: string;
  task_type: WmsTaskType;
  uom: string;
  seconds_per_uom: number;
  setup_seconds: number;
  travel_seconds_per_metre: number;
  warehouse_id: string | null;
  zone_id: string | null;
  product_category_id: string | null;
  equipment_class: string | null;
  is_active: boolean;
  notes: string | null;
}

interface Props {
  warehouses: Array<{ id: string; name: string }>;
}

export function StandardsPanel({ warehouses }: Props) {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    task_type: "pick" as WmsTaskType,
    uom: "unit",
    seconds_per_uom: 30,
    setup_seconds: 0,
    travel_seconds_per_metre: 0,
    warehouse_id: ANY,
    zone_id: ANY,
    product_category_id: ANY,
    equipment_class: "",
    notes: "",
  });

  const { data: standards, isLoading } = useQuery({
    queryKey: [...LABOUR_KEYS.standards, currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_task_standards")
        .select(
          "id,task_type,uom,seconds_per_uom,setup_seconds,travel_seconds_per_metre,warehouse_id,zone_id,product_category_id,equipment_class,is_active,notes",
        )
        .eq("business_id", currentBusiness!.id)
        .order("task_type");
      if (error) throw error;
      return (data ?? []) as unknown as StandardRow[];
    },
  });

  const { data: zones } = useQuery({
    queryKey: ["wms-standard-zones", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id,name,warehouse_id")
        .eq("business_id", currentBusiness!.id)
        .limit(300);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; name: string; warehouse_id: string | null }>;
    },
  });

  const { data: categories } = useQuery({
    queryKey: ["wms-standard-categories", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_categories")
        .select("id,name")
        .eq("business_id", currentBusiness!.id)
        .limit(300);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: LABOUR_KEYS.standards });

  const createStandard = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id) throw new Error("No active business");
      const { error } = await supabase.from("wms_task_standards").insert({
        business_id: currentBusiness.id,
        task_type: form.task_type,
        uom: form.uom.trim() || "unit",
        seconds_per_uom: Number(form.seconds_per_uom),
        setup_seconds: Number(form.setup_seconds),
        travel_seconds_per_metre: Number(form.travel_seconds_per_metre),
        warehouse_id: form.warehouse_id === ANY ? null : form.warehouse_id,
        zone_id: form.zone_id === ANY ? null : form.zone_id,
        product_category_id: form.product_category_id === ANY ? null : form.product_category_id,
        equipment_class: form.equipment_class.trim() || null,
        notes: form.notes.trim() || null,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Standard saved"); setOpen(false); invalidate(); },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  const toggleStandard = useMutation({
    mutationFn: async (row: StandardRow) => {
      const { error } = await supabase
        .from("wms_task_standards")
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  const deleteStandard = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("wms_task_standards").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Standard removed"); invalidate(); },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  const nameOf = (list: Array<{ id: string; name: string }> | undefined, id: string | null) =>
    id ? list?.find((x) => x.id === id)?.name ?? id.slice(0, 8) : "Any";

  return (
    <>
      <div className="flex justify-end mb-3">
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> New standard
        </Button>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (standards ?? []).length === 0 ? (
        <EmptyState
          title="No labour standards"
          description="Define engineered standards so completed tasks earn hours and utilisation becomes measurable."
          action={<Button onClick={() => setOpen(true)}>New standard</Button>}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Zone</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Equipment</TableHead>
              <TableHead className="text-right">Setup (s)</TableHead>
              <TableHead className="text-right">Per {`{uom}`} (s)</TableHead>
              <TableHead className="text-right">Travel (s/m)</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(standards ?? []).map((s) => (
              <TableRow key={s.id}>
                <TableCell className="capitalize font-medium">
                  {s.task_type}
                  <div className="text-xs text-muted-foreground">{s.uom}</div>
                </TableCell>
                <TableCell>{nameOf(warehouses, s.warehouse_id)}</TableCell>
                <TableCell>{nameOf(zones, s.zone_id)}</TableCell>
                <TableCell>{nameOf(categories, s.product_category_id)}</TableCell>
                <TableCell>{s.equipment_class ?? <Badge variant="outline">Any</Badge>}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(s.setup_seconds)}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(s.seconds_per_uom)}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(s.travel_seconds_per_metre)}</TableCell>
                <TableCell>
                  <Switch checked={s.is_active} onCheckedChange={() => toggleStandard.mutate(s)} />
                </TableCell>
                <TableCell>
                  <Button size="icon" variant="ghost" onClick={() => deleteStandard.mutate(s.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New labour standard</DialogTitle>
            <DialogDescription>
              Leave a dimension as “Any” to make this the fallback. The most specific
              matching standard is used when a task earns hours.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0 grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Task type</Label>
              <Select
                value={form.task_type}
                onValueChange={(v) => setForm((f) => ({ ...f, task_type: v as WmsTaskType }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WMS_TASK_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Unit of measure</Label>
              <Input value={form.uom} onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value }))} />
            </div>

            <div className="space-y-1.5">
              <Label>Warehouse</Label>
              <Select
                value={form.warehouse_id}
                onValueChange={(v) => setForm((f) => ({ ...f, warehouse_id: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any warehouse</SelectItem>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Zone / location</Label>
              <Select value={form.zone_id} onValueChange={(v) => setForm((f) => ({ ...f, zone_id: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any zone</SelectItem>
                  {(zones ?? [])
                    .filter((z) => form.warehouse_id === ANY || z.warehouse_id === form.warehouse_id)
                    .map((z) => (
                      <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Product category</Label>
              <Select
                value={form.product_category_id}
                onValueChange={(v) => setForm((f) => ({ ...f, product_category_id: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any category</SelectItem>
                  {(categories ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Equipment class</Label>
              <Input
                placeholder="Any"
                value={form.equipment_class}
                onChange={(e) => setForm((f) => ({ ...f, equipment_class: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Setup seconds (fixed per task)</Label>
              <Input
                type="number" min={0}
                value={form.setup_seconds}
                onChange={(e) => setForm((f) => ({ ...f, setup_seconds: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Seconds per {form.uom || "unit"}</Label>
              <Input
                type="number" min={0}
                value={form.seconds_per_uom}
                onChange={(e) => setForm((f) => ({ ...f, seconds_per_uom: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Travel seconds per metre</Label>
              <Input
                type="number" min={0} step="0.01"
                value={form.travel_seconds_per_metre}
                onChange={(e) => setForm((f) => ({ ...f, travel_seconds_per_metre: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => createStandard.mutate()} disabled={createStandard.isPending}>
              {createStandard.isPending ? "Saving…" : "Save standard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
