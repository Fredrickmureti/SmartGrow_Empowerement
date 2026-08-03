/**
 * CountTriggers — admin surface for `wms_count_triggers` (ADR 0106,
 * invariant 5: counts can be provoked by events).
 *
 * A rule queues a targeted recount of a bin after a warehouse event
 * (variance, replenishment, return, receipt), with a cooldown so the same
 * bin is not re-counted repeatedly. Rules are evaluated server-side off
 * the business event outbox; this page only maintains the policy rows.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { PageHeader, PageBody, Section, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { Zap, Plus, Trash2 } from "lucide-react";

const TRIGGER_EVENTS = [
  { value: "variance", label: "Pick/putaway variance", help: "Bin short-picked or over-picked." },
  { value: "replenishment", label: "Replenishment", help: "Bin refilled from reserve." },
  { value: "return", label: "Customer return", help: "Stock returned into the bin." },
  { value: "receipt", label: "Goods receipt", help: "Bin received new inbound stock." },
] as const;

interface TriggerRow {
  id: string;
  warehouse_id: string;
  trigger_event: string;
  blind: boolean;
  cooldown_hours: number;
  is_active: boolean;
}

export default function CountTriggers() {
  const qc = useQueryClient();
  const { warehouses } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();

  const [warehouseId, setWarehouseId] = useState<string>("");
  const [triggerEvent, setTriggerEvent] = useState<string>("variance");
  const [blind, setBlind] = useState(true);
  const [cooldown, setCooldown] = useState("24");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-count-triggers", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_triggers")
        .select("id, warehouse_id, trigger_event, blind, cooldown_hours, is_active")
        .eq("business_id", currentBusiness!.id)
        .order("trigger_event");
      if (error) throw error;
      return (data ?? []) as TriggerRow[];
    },
  });

  const warehouseName = useMemo(() => {
    const map = new Map((warehouses ?? []).map((w) => [w.id, w.name]));
    return (id: string) => map.get(id) ?? "—";
  }, [warehouses]);

  const createRule = useMutation({
    mutationFn: async () => {
      if (!warehouseId) throw new Error("Pick a warehouse");
      if (!currentBusiness?.id || !currentOrg?.id) throw new Error("No active business");
      const hours = Number(cooldown);
      if (!Number.isFinite(hours) || hours < 0) throw new Error("Cooldown must be 0 or more hours");
      const { error } = await supabase.from("wms_count_triggers").insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        warehouse_id: warehouseId,
        trigger_event: triggerEvent,
        blind,
        cooldown_hours: Math.round(hours),
        is_active: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Trigger rule saved");
      qc.invalidateQueries({ queryKey: ["wms-count-triggers"] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not save the rule"),
  });

  const updateRule = useMutation({
    mutationFn: async (input: { id: string; patch: Partial<TriggerRow> }) => {
      const { error } = await supabase
        .from("wms_count_triggers")
        .update(input.patch)
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-count-triggers"] }),
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not update the rule"),
  });

  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("wms_count_triggers").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rule removed");
      qc.invalidateQueries({ queryKey: ["wms-count-triggers"] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not remove the rule"),
  });

  return (
    <>
      <PageHeader
        title="Count automation"
        description="Rules that queue a targeted recount of a bin after a warehouse event. Cooldown stops the same bin being counted repeatedly."
      />
      <PageBody>
        <Section title="Active rules">
          {isLoading ? (
            <LoadingState />
          ) : (rows ?? []).length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No automation rules"
              description="Add a rule below to auto-count a bin after a variance, replenishment, return or receipt."
            />
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Warehouse</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Blind</TableHead>
                      <TableHead>Cooldown</TableHead>
                      <TableHead>Active</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(rows ?? []).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>{warehouseName(r.warehouse_id)}</TableCell>
                        <TableCell>
                          {TRIGGER_EVENTS.find((e) => e.value === r.trigger_event)?.label ?? r.trigger_event}
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={r.blind}
                            aria-label="Blind counting"
                            onCheckedChange={(v) => updateRule.mutate({ id: r.id, patch: { blind: v } })}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-sm">{r.cooldown_hours}h</TableCell>
                        <TableCell>
                          <Switch
                            checked={r.is_active}
                            aria-label="Rule active"
                            onCheckedChange={(v) => updateRule.mutate({ id: r.id, patch: { is_active: v } })}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => deleteRule.mutate(r.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </Section>

        <Section title="Add a rule">
          <Card>
            <CardContent className="pt-6 grid gap-4 md:grid-cols-4">
              <div>
                <Label>Warehouse</Label>
                <Select value={warehouseId} onValueChange={setWarehouseId}>
                  <SelectTrigger><SelectValue placeholder="Pick a warehouse…" /></SelectTrigger>
                  <SelectContent>
                    {(warehouses ?? []).map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Event</Label>
                <Select value={triggerEvent} onValueChange={setTriggerEvent}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TRIGGER_EVENTS.map((e) => (
                      <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {TRIGGER_EVENTS.find((e) => e.value === triggerEvent)?.help}
                </p>
              </div>
              <div>
                <Label htmlFor="cooldown">Cooldown (hours)</Label>
                <Input
                  id="cooldown"
                  inputMode="numeric"
                  value={cooldown}
                  onChange={(e) => setCooldown(e.target.value)}
                />
              </div>
              <div className="flex flex-col justify-between gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={blind} onCheckedChange={setBlind} aria-label="Blind counting" />
                  Blind count
                </label>
                <Button onClick={() => createRule.mutate()} disabled={createRule.isPending}>
                  <Plus className="h-4 w-4 mr-2" /> Add rule
                </Button>
              </div>
            </CardContent>
          </Card>
        </Section>
      </PageBody>
    </>
  );
}
