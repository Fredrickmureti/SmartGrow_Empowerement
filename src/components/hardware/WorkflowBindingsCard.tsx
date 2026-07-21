/**
 * WorkflowBindingsCard — Phase 14 step 6 (ADR-0085 · ownership matrix)
 *
 * Admin surface for `printer_workflow_bindings`. Operators bind a
 * `printer_profile` to a `printer_workflow` at org / branch / warehouse
 * scope, so `printLabelByTemplate({ workflow: 'receiving' })` (and every
 * other caller of the same seam) resolves the right physical printer
 * without any hard-coded assumptions.
 *
 * The runtime path is `resolve_workflow_printer` (server-side SECURITY
 * DEFINER function); this card is purely the CRUD surface. Priority is
 * exposed because tenants with multiple back-office printers routinely
 * bind a "primary" (priority=100) and a "fallback" (priority=200) to the
 * same workflow — the resolver picks the lowest priority winner.
 *
 * RLS: admin/owner-only writes (see policy `pwb_admin_write`). Read is
 * gated by org membership. The UI mirrors that: non-admins see the list
 * but not the add / remove controls.
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
import { normalizeError } from "@/services/resilience";
import type { PrinterWorkflow } from "@/services/printing/labelDispatch";

// Keep this list in sync with the DB enum `printer_workflow` and with
// `PrinterWorkflow` in `labelDispatch.ts`. The "hint" copy is user-facing
// so operators can reason about which physical printer to bind.
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
  org_id: string;
  branch_id: string | null;
  warehouse_id: string | null;
  workflow: PrinterWorkflow;
  printer_profile_id: string;
  priority: number;
  active: boolean;
}

interface PrinterOption {
  id: string;
  label: string;
  transport: string;
  command_language: string | null;
  dpi: number | null;
  is_active: boolean;
}

interface DraftForm {
  workflow: PrinterWorkflow;
  printer_profile_id: string;
  branch_id: string;
  priority: string;
}

const EMPTY_DRAFT: DraftForm = {
  workflow: "product_tag",
  printer_profile_id: "",
  branch_id: "",
  priority: "100",
};

export function WorkflowBindingsCard() {
  const { currentOrg, currentBranch } = useOrganization();
  const orgId = currentOrg?.id ?? null;

  const [bindings, setBindings] = useState<Binding[]>([]);
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [bRes, pRes] = await Promise.all([
        supabase
          .from("printer_workflow_bindings")
          .select("id, org_id, branch_id, warehouse_id, workflow, printer_profile_id, priority, active")
          .eq("org_id", orgId)
          .order("workflow", { ascending: true })
          .order("priority", { ascending: true }),
        supabase
          .from("printer_profiles")
          .select("id, label, transport, command_language, dpi, is_active")
          .eq("business_id", orgId)
          .order("label", { ascending: true }),
      ]);
      if (bRes.error) throw bRes.error;
      if (pRes.error) throw pRes.error;
      setBindings((bRes.data ?? []) as Binding[]);
      setPrinters((pRes.data ?? []) as PrinterOption[]);
    } catch (e) {
      toast.error(`Failed to load workflow bindings: ${normalizeError(e).message}`);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const printerById = useMemo(() => {
    const m = new Map<string, PrinterOption>();
    for (const p of printers) m.set(p.id, p);
    return m;
  }, [printers]);

  const handleAdd = useCallback(async () => {
    if (!orgId) return;
    if (!draft.printer_profile_id) {
      toast.error("Choose a printer profile to bind.");
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
        .from("printer_workflow_bindings")
        .insert({
          org_id: orgId,
          branch_id: draft.branch_id || null,
          warehouse_id: null,
          workflow: draft.workflow,
          printer_profile_id: draft.printer_profile_id,
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
        .from("printer_workflow_bindings")
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
          <CardDescription>Select an organization to manage printer / workflow bindings.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card data-testid="workflow-bindings-card">
      <CardHeader>
        <CardTitle className="text-base">Workflow bindings</CardTitle>
        <CardDescription>
          Route each printing workflow to a specific printer profile. Lower priority wins when
          multiple bindings match. Leave branch blank for an org-wide default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* --- Add form --- */}
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
              <Label htmlFor="binding-printer" className="text-xs">Printer profile</Label>
              <Select
                value={draft.printer_profile_id}
                onValueChange={(v) => setDraft((d) => ({ ...d, printer_profile_id: v }))}
              >
                <SelectTrigger id="binding-printer" data-testid="binding-printer-trigger">
                  <SelectValue placeholder={printers.length === 0 ? "No printer profiles" : "Choose printer"} />
                </SelectTrigger>
                <SelectContent>
                  {printers.map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={!p.is_active}>
                      {p.label}
                      <span className="ml-2 text-xs text-muted-foreground font-mono">
                        {(p.command_language ?? "?").toUpperCase()} · {p.transport} · {p.dpi ?? "?"} dpi
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
              disabled={saving || printers.length === 0}
              data-testid="binding-add-submit"
            >
              {saving ? "Adding…" : "Add binding"}
            </Button>
          </div>
        </div>

        {/* --- Existing bindings --- */}
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No workflow bindings yet. The dispatcher will fall back to any active printer profile for the org.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Printer</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bindings.map((b) => {
                  const printer = printerById.get(b.printer_profile_id);
                  return (
                    <TableRow key={b.id} data-testid={`binding-row-${b.id}`}>
                      <TableCell className="text-xs font-mono">{b.workflow}</TableCell>
                      <TableCell className="text-xs">
                        {printer?.label ?? <span className="text-muted-foreground">[missing profile]</span>}
                        {printer && (
                          <span className="ml-2 text-muted-foreground font-mono">
                            {(printer.command_language ?? "?").toUpperCase()} · {printer.dpi ?? "?"} dpi
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
