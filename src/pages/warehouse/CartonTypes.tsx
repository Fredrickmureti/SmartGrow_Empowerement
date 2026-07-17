/**
 * Carton Types — Phase 12 master data.
 *
 * Catalogue of reusable shipping cartons. Consumed by the `suggest_carton`
 * RPC and stamped onto `wms_pack_cartons.carton_type_id` at pack time.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, PackageOpen } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";

interface CartonType {
  id: string;
  code: string;
  name: string;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  max_weight_kg: number;
  tare_weight_kg: number;
  cost: number;
  is_active: boolean;
  notes: string | null;
}

const empty = {
  code: "",
  name: "",
  length_cm: 30,
  width_cm: 20,
  height_cm: 15,
  max_weight_kg: 20,
  tare_weight_kg: 0.2,
  cost: 0,
  notes: "",
};

export default function CartonTypes() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);

  const { data, isLoading } = useQuery({
    queryKey: ["wms-carton-types", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_carton_types")
        .select("id,code,name,length_cm,width_cm,height_cm,max_weight_kg,tare_weight_kg,cost,is_active,notes")
        .eq("business_id", currentBusiness!.id)
        .order("code");
      if (error) throw error;
      return (data ?? []) as CartonType[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id) throw new Error("No active business");
      const { error } = await supabase.from("wms_carton_types").insert({
        business_id: currentBusiness.id,
        code: form.code.trim(),
        name: form.name.trim(),
        length_cm: Number(form.length_cm),
        width_cm: Number(form.width_cm),
        height_cm: Number(form.height_cm),
        max_weight_kg: Number(form.max_weight_kg),
        tare_weight_kg: Number(form.tare_weight_kg),
        cost: Number(form.cost),
        notes: form.notes.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Carton saved");
      setOpen(false);
      setForm(empty);
      qc.invalidateQueries({ queryKey: ["wms-carton-types"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: async (row: CartonType) => {
      const { error } = await supabase
        .from("wms_carton_types")
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-carton-types"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("wms_carton_types").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Carton removed");
      qc.invalidateQueries({ queryKey: ["wms-carton-types"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Carton catalogue"
        description="Reusable shipping cartons used by the cartonization engine at pack time."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> New carton
          </Button>
        }
      />
      <PageBody>
        {isLoading ? (
          <LoadingState />
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={PackageOpen}
            title="No cartons defined"
            description="Add at least one carton so the suggest-carton engine can pick a fit."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Inner L×W×H (cm)</TableHead>
                <TableHead>Max weight</TableHead>
                <TableHead>Tare</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono">{r.code}</TableCell>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{r.length_cm}×{r.width_cm}×{r.height_cm}</TableCell>
                  <TableCell>{r.max_weight_kg} kg</TableCell>
                  <TableCell>{r.tare_weight_kg} kg</TableCell>
                  <TableCell>{Number(r.cost).toFixed(2)}</TableCell>
                  <TableCell>
                    <Switch checked={r.is_active} onCheckedChange={() => toggle.mutate(r)} />
                  </TableCell>
                  <TableCell>
                    <Button size="icon" variant="ghost" onClick={() => remove.mutate(r.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PageBody>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New carton type</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
            <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label>Length (cm)</Label><Input type="number" value={form.length_cm} onChange={(e) => setForm({ ...form, length_cm: Number(e.target.value) })} /></div>
            <div><Label>Width (cm)</Label><Input type="number" value={form.width_cm} onChange={(e) => setForm({ ...form, width_cm: Number(e.target.value) })} /></div>
            <div><Label>Height (cm)</Label><Input type="number" value={form.height_cm} onChange={(e) => setForm({ ...form, height_cm: Number(e.target.value) })} /></div>
            <div><Label>Max weight (kg)</Label><Input type="number" value={form.max_weight_kg} onChange={(e) => setForm({ ...form, max_weight_kg: Number(e.target.value) })} /></div>
            <div><Label>Tare weight (kg)</Label><Input type="number" step="0.01" value={form.tare_weight_kg} onChange={(e) => setForm({ ...form, tare_weight_kg: Number(e.target.value) })} /></div>
            <div><Label>Cost</Label><Input type="number" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })} /></div>
            <div className="col-span-2"><Label>Notes</Label><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.code.trim() || !form.name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
