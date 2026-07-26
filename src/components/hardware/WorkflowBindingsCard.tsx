/**
 * WorkflowBindingsCard — Phase 2b (unified device registry).
 *
 * Binds a `device_assignments` row (any printer) to a `printer_workflow` at
 * org / branch / warehouse scope. Runtime resolution goes through the
 * `resolve_device_for_workflow` RPC.
 *
 * RLS: admin/owner-only writes on `device_workflow_bindings`. Read is
 * gated by org membership.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranches } from "@/hooks/useBranches";
import { normalizeError } from "@/services/resilience";
import type { PrinterWorkflow } from "@/services/printing/labelDispatch";

const WORKFLOWS: { value: PrinterWorkflow; label: string; hint: string }[] = [
  { value: "product_tag", label: "Product tag", hint: "Small item labels (Products, POS reprint)." },
  { value: "shelf_edge", label: "Shelf edge", hint: "Price / shelf-edge labels (Inventory, price change)." },
  { value: "receiving", label: "Receiving", hint: "GRN / putaway labels (Warehouse receiving)." },
  { value: "shipping", label: "Shipping", hint: "Address / carrier labels (Warehouse dispatch)." },
  { value: "asset_tag", label: "Asset tag", hint: "Fixed-asset and equipment tags." },
  { value: "kitchen_hot", label: "Kitchen (hot)", hint: "Order tickets to hot line printers." },
  { value: "kitchen_bar", label: "Kitchen (cold)", hint: "Order tickets to cold prep printers." },
  { value: "bar", label: "Bar", hint: "Drink tickets to bar printers." },
  { value: "payslip", label: "Payslip", hint: "HR / payroll slip printing." },
  { value: "generic", label: "Generic", hint: "Ad-hoc / fallback binding." },
];

interface Binding {
  id: string;
  organization_id: string;
  branch_id: string | null;
  warehouse_id: string | null;
  workflow: PrinterWorkflow;
  device_assignment_id: string;
  priority: number;
  active: boolean;
}

interface DeviceOption {
  id: string;
  display_name: string;
  transport: string;
  command_language: string | null;
  dpi: number | null;
  enabled: boolean;
  role: string;
}

interface DraftForm {
  workflow: PrinterWorkflow;
  device_assignment_id: string;
  branch_id: string;
  priority: string;
}

const EMPTY_DRAFT: DraftForm = {
  workflow: "product_tag",
  device_assignment_id: "",
  branch_id: "",
  priority: "100",
};

const PRINTER_ROLES = ["receipt_printer", "a4_printer", "label_printer"];

export function WorkflowBindingsCard() {
  const { currentOrg } = useOrganization();
  const { currentBranch } = useBranches();
  const orgId = currentOrg?.id ?? null;

  const [bindings, setBindings] = useState<Binding[]>([]);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [bRes, dRes] = await Promise.all([
        supabase
          .from("device_workflow_bindings")
          .select("id, organization_id, branch_id, warehouse_id, workflow, device_assignment_id, priority, active")
          .eq("organization_id", orgId)
          .order("workflow", { ascending: true })
          .order("priority", { ascending: true }),
        supabase
          .from("device_assignments")
          .select("id, display_name, transport, command_language, dpi, enabled, role")
          .eq("organization_id", orgId)
          .in("role", PRINTER_ROLES)
          .order("display_name", { ascending: true }),
      ]);
      if (bRes.error) throw bRes.error;
      if (dRes.error) throw dRes.error;
      setBindings((bRes.data ?? []) as Binding[]);
      setDevices((dRes.data ?? []) as DeviceOption[]);
    } catch (e) {
      toast.error(`Failed to load workflow bindings: ${normalizeError(e).message}`);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const deviceById = useMemo(() => {
    const m = new Map<string, DeviceOption>();
    for (const p of devices) m.set(p.id, p);
    return m;
  }, [devices]);

  const handleAdd = useCallback(async () => {
    if (!orgId) return;
    if (!draft.device_assignment_id) {
      toast.error("Choose a printer to bind.");
      return;
    }
    const priority = Number.parseInt(draft.priority, 10);
    if (!Number.isFinite(priority) || priority < 1) {
      toast.error("Priority must be a positive integer (lower wins).");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("device_workflow_bindings")
        .insert({
          organization_id: orgId,
          branch_id: draft.branch_id || null,
          warehouse_id: null,
          workflow: draft.workflow,
          device_assignment_id: draft.device_assignment_id,
          priority,
          active: true,
        });
      if (error) throw error;
      toast.success("Workflow binding added.");
      setDraft({ ...EMPTY_DRAFT, branch_id: draft.branch_id });
      await refresh();
    } catch (e) {
      toast.error(`Failed to add binding: ${normalizeError(e).message}`);
    } finally {
      setSaving(false);
    }
  }, [orgId, draft, refresh]);

  const handleRemove = useCallback(async (id: string) => {
    setRemovingId(id);
    try {
      const { error } = await supabase
        .from("device_workflow_bindings")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("Binding removed.");
      await refresh();
    } catch (e) {
      toast.error(`Failed to remove binding: ${normalizeError(e).message}`);
    } finally {
      setRemovingId(null);
    }
  }, [refresh]);

  if (!orgId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workflow bindings</CardTitle>
          <CardDescription>Select an organization to manage device / workflow bindings.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card data-testid="workflow-bindings-card">
      <CardHeader>
        <CardTitle className="text-base">Workflow bindings</CardTitle>
        <CardDescription>
          Route each printing workflow to a specific device. Lower priority wins when
          multiple bindings match. Leave branch blank for an org-wide default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-md border p-3 space-y-3" data-testid="binding-add-form">
          <p className="text-sm font-medium">Add binding</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="binding-workflow" className="text-xs">Workflow</Label>
              <Select
                value={draft.workflow}
                onValueChange={(v) => setDraft((d) => ({ ...d, workflow: v as PrinterWorkflow }))}
              >
                <SelectTrigger id="binding-workflow" data-testid="binding-workflow-trigger">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKFLOWS.map((w) => (
                    <SelectItem key={w.value} value={w.value}>
                      <div className="flex flex-col">
                        <span>{w.label}</span>
                        <span className="text-xs text-muted-foreground">{w.hint}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="binding-printer" className="text-xs">Device</Label>
              <Select
                value={draft.device_assignment_id}
                onValueChange={(v) => setDraft((d) => ({ ...d, device_assignment_id: v }))}
              >
                <SelectTrigger id="binding-printer" data-testid="binding-printer-trigger">
                  <SelectValue placeholder={devices.length === 0 ? "No devices" : "Choose device"} />
                </SelectTrigger>
                <SelectContent>
                  {devices.map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={!p.enabled}>
                      {p.display_name}
                      <span className="ml-2 text-xs text-muted-foreground font-mono">
                        {(p.command_language ?? p.role).toUpperCase()} · {p.transport} · {p.dpi ?? "?"} dpi
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="binding-branch" className="text-xs">Branch scope (optional)</Label>
              <Select
                value={draft.branch_id || "__ORG__"}
                onValueChange={(v) => setDraft((d) => ({ ...d, branch_id: v === "__ORG__" ? "" : v }))}
              >
                <SelectTrigger id="binding-branch" data-testid="binding-branch-trigger">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__ORG__">Org-wide default</SelectItem>
                  {currentBranch?.id && (
                    <SelectItem value={currentBranch.id}>Current branch ({currentBranch.name ?? currentBranch.id.slice(0, 8)})</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="binding-priority" className="text-xs">Priority</Label>
              <Input
                id="binding-priority"
                type="number"
                min={1}
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                data-testid="binding-priority-input"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => void handleAdd()}
              disabled={saving || devices.length === 0}
              data-testid="binding-add-submit"
            >
              {saving ? "Adding…" : "Add binding"}
            </Button>
          </div>
        </div>

        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No workflow bindings yet. The dispatcher will fall back to any active device for the org.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bindings.map((b) => {
                  const device = deviceById.get(b.device_assignment_id);
                  return (
                    <TableRow key={b.id} data-testid={`binding-row-${b.id}`}>
                      <TableCell className="text-xs font-mono">{b.workflow}</TableCell>
                      <TableCell className="text-xs">
                        {device?.display_name ?? <span className="text-muted-foreground">[missing device]</span>}
                        {device && (
                          <span className="ml-2 text-muted-foreground font-mono">
                            {(device.command_language ?? device.role).toUpperCase()} · {device.dpi ?? "?"} dpi
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {b.branch_id ? `branch ${b.branch_id.slice(0, 8)}…` : "org-wide"}
                      </TableCell>
                      <TableCell className="text-xs">{b.priority}</TableCell>
                      <TableCell>
                        <Badge variant={b.active ? "default" : "outline"}>
                          {b.active ? "active" : "disabled"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={removingId === b.id}
                          onClick={() => void handleRemove(b.id)}
                          data-testid={`binding-remove-${b.id}`}
                        >
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default WorkflowBindingsCard;
