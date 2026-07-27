/**
 * Hardware Roles — Wave 6 admin surface.
 *
 * CRUD on `printer_roles` (organization scoped) and per-branch bindings
 * to `device_assignments` via `printer_role_branch_bindings`. System roles
 * (`is_system=true`) are read-only; custom roles can be added/deactivated.
 *
 * Bindings are ordered by `priority`; the runtime dispatcher walks them in
 * ascending order and picks the first assignment whose device is online
 * (`resolve_hardware_assignment` RPC). Marking one binding `is_primary`
 * pins it as the default even if lower priorities exist.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Printer, Trash2, Star, StarOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useDeviceAssignments } from "@/hooks/useDeviceAssignments";

interface PrinterRole {
  id: string;
  organization_id: string;
  code: string;
  label: string;
  hardware_kind: string;
  default_media_class: string | null;
  description: string | null;
  is_active: boolean;
  is_system: boolean;
}

interface Binding {
  id: string;
  role_id: string;
  branch_id: string;
  device_assignment_id: string;
  is_primary: boolean;
  priority: number;
}

const HARDWARE_KIND_OPTIONS = [
  { value: "receipt_printer", label: "Receipt printer" },
  { value: "label_printer", label: "Label printer" },
  { value: "kitchen_printer", label: "Kitchen printer" },
  { value: "office_printer", label: "Office / A4 printer" },
  { value: "fiscal_device", label: "Fiscal device" },
];

const sb = supabase as unknown as {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export default function HardwareRoles() {
  const { currentBusiness } = useBusinesses();
  const { currentBranch, branches } = useBranches();
  const orgId = currentBusiness?.organization_id ?? null;
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedBranchId && currentBranch) setSelectedBranchId(currentBranch.id);
  }, [currentBranch, selectedBranchId]);

  const qc = useQueryClient();

  const rolesQuery = useQuery({
    enabled: !!orgId,
    queryKey: ["printer_roles", orgId],
    queryFn: async (): Promise<PrinterRole[]> => {
      const { data, error } = await sb
        .from("printer_roles")
        .select("id,organization_id,code,label,hardware_kind,default_media_class,description,is_active,is_system")
        .eq("organization_id", orgId)
        .order("is_system", { ascending: false })
        .order("code");
      if (error) throw error;
      return (data ?? []) as PrinterRole[];
    },
  });

  const bindingsQuery = useQuery({
    enabled: !!orgId && !!selectedBranchId,
    queryKey: ["printer_role_branch_bindings", orgId, selectedBranchId],
    queryFn: async (): Promise<Binding[]> => {
      const { data, error } = await sb
        .from("printer_role_branch_bindings")
        .select("id,role_id,branch_id,device_assignment_id,is_primary,priority")
        .eq("organization_id", orgId)
        .eq("branch_id", selectedBranchId)
        .order("priority");
      if (error) throw error;
      return (data ?? []) as Binding[];
    },
  });

  const { assignments = [] } = useDeviceAssignments() as unknown as {
    assignments: Array<{ id: string; display_name: string; device_kind: string }>;
  };

  const bindingsByRole = useMemo(() => {
    const map = new Map<string, Binding[]>();
    for (const b of bindingsQuery.data ?? []) {
      const list = map.get(b.role_id) ?? [];
      list.push(b);
      map.set(b.role_id, list);
    }
    return map;
  }, [bindingsQuery.data]);

  const createRole = useMutation({
    mutationFn: async (input: {
      code: string; label: string; hardware_kind: string; description: string;
    }) => {
      const { error } = await sb.from("printer_roles").insert({
        organization_id: orgId,
        code: input.code.trim(),
        label: input.label.trim(),
        hardware_kind: input.hardware_kind,
        description: input.description.trim() || null,
        is_active: true,
        is_system: false,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role created");
      qc.invalidateQueries({ queryKey: ["printer_roles", orgId] });
    },
    onError: (e: Error) => toast.error(`Create failed: ${e.message}`),
  });

  const toggleRoleActive = useMutation({
    mutationFn: async (role: PrinterRole) => {
      const { error } = await sb
        .from("printer_roles")
        .update({ is_active: !role.is_active })
        .eq("id", role.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["printer_roles", orgId] }),
    onError: (e: Error) => toast.error(`Update failed: ${e.message}`),
  });

  const addBinding = useMutation({
    mutationFn: async (input: { roleId: string; deviceId: string; priority: number }) => {
      const existing = bindingsByRole.get(input.roleId) ?? [];
      const { error } = await sb.from("printer_role_branch_bindings").insert({
        organization_id: orgId,
        branch_id: selectedBranchId,
        role_id: input.roleId,
        device_assignment_id: input.deviceId,
        priority: input.priority,
        is_primary: existing.length === 0,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Printer bound to role");
      qc.invalidateQueries({ queryKey: ["printer_role_branch_bindings", orgId, selectedBranchId] });
    },
    onError: (e: Error) => toast.error(`Bind failed: ${e.message}`),
  });

  const removeBinding = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sb.from("printer_role_branch_bindings").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Binding removed");
      qc.invalidateQueries({ queryKey: ["printer_role_branch_bindings", orgId, selectedBranchId] });
    },
    onError: (e: Error) => toast.error(`Remove failed: ${e.message}`),
  });

  const setPrimary = useMutation({
    mutationFn: async (binding: Binding) => {
      // Clear existing primary for role+branch, then set this one.
      const { error: clearErr } = await sb
        .from("printer_role_branch_bindings")
        .update({ is_primary: false })
        .eq("role_id", binding.role_id)
        .eq("branch_id", binding.branch_id);
      if (clearErr) throw clearErr;
      const { error } = await sb
        .from("printer_role_branch_bindings")
        .update({ is_primary: true })
        .eq("id", binding.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({
      queryKey: ["printer_role_branch_bindings", orgId, selectedBranchId],
    }),
    onError: (e: Error) => toast.error(`Update failed: ${e.message}`),
  });

  if (!orgId) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Printer roles</CardTitle>
            <CardDescription>Select a business to manage printer roles.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Printer className="h-6 w-6" /> Printer roles
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Roles decouple business documents from physical printers. A
            document intent asks for a <em>role</em> (e.g. <code>receipt_thermal</code>);
            per-branch bindings decide which device actually prints it.
            Runtime picks the first online device, falling back down the priority list.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Branch</Label>
          <Select
            value={selectedBranchId ?? ""}
            onValueChange={(v) => setSelectedBranchId(v)}
          >
            <SelectTrigger className="w-60"><SelectValue placeholder="Select a branch" /></SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <NewRoleDialog onCreate={(input) => createRole.mutate(input)} pending={createRole.isPending} />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {rolesQuery.isLoading ? (
            <div className="p-8 text-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading roles…
            </div>
          ) : (rolesQuery.data ?? []).length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No printer roles yet. The five canonical roles seed automatically
              on first use.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Bindings for branch</TableHead>
                  <TableHead className="w-[180px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(rolesQuery.data ?? []).map((role) => {
                  const bindings = bindingsByRole.get(role.id) ?? [];
                  return (
                    <TableRow key={role.id} className={!role.is_active ? "opacity-60" : ""}>
                      <TableCell>
                        <div className="font-medium flex items-center gap-2">
                          {role.label}
                          {role.is_system && <Badge variant="outline">System</Badge>}
                          {!role.is_active && <Badge variant="secondary">Inactive</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">{role.code}</div>
                        {role.description && (
                          <div className="text-xs text-muted-foreground mt-0.5">{role.description}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{role.hardware_kind}</TableCell>
                      <TableCell>
                        {!selectedBranchId ? (
                          <span className="text-xs text-muted-foreground">Pick a branch…</span>
                        ) : bindings.length === 0 ? (
                          <span className="text-xs text-muted-foreground">No devices bound</span>
                        ) : (
                          <div className="space-y-1">
                            {bindings.map((b) => {
                              const dev = assignments.find((a) => a.id === b.device_assignment_id);
                              return (
                                <div key={b.id} className="flex items-center gap-2 text-sm">
                                  <span className="text-xs text-muted-foreground w-8">#{b.priority}</span>
                                  <span className="flex-1 truncate">{dev?.display_name ?? "Unknown device"}</span>
                                  {b.is_primary && <Badge variant="default" className="text-[10px]">Primary</Badge>}
                                  {!b.is_primary && (
                                    <Button size="icon" variant="ghost" className="h-6 w-6"
                                      title="Set as primary"
                                      onClick={() => setPrimary.mutate(b)}>
                                      <StarOff className="h-3 w-3" />
                                    </Button>
                                  )}
                                  {b.is_primary && (
                                    <Star className="h-3 w-3 text-amber-500" />
                                  )}
                                  <Button size="icon" variant="ghost" className="h-6 w-6"
                                    title="Remove binding"
                                    onClick={() => removeBinding.mutate(b.id)}>
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {selectedBranchId && (
                            <BindDeviceInline
                              disabled={addBinding.isPending || !role.is_active}
                              devices={assignments}
                              takenIds={new Set(bindings.map((b) => b.device_assignment_id))}
                              onBind={(deviceId) =>
                                addBinding.mutate({
                                  roleId: role.id,
                                  deviceId,
                                  priority: bindings.length + 1,
                                })
                              }
                            />
                          )}
                          {!role.is_system && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => toggleRoleActive.mutate(role)}
                            >
                              {role.is_active ? "Deactivate role" : "Activate role"}
                            </Button>
                          )}
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
    </div>
  );
}

function BindDeviceInline({
  devices, takenIds, onBind, disabled,
}: {
  devices: Array<{ id: string; display_name: string; device_kind: string }>;
  takenIds: Set<string>;
  onBind: (deviceId: string) => void;
  disabled?: boolean;
}) {
  const available = devices.filter((d) => !takenIds.has(d.id));
  if (available.length === 0) {
    return <span className="text-xs text-muted-foreground">All devices bound</span>;
  }
  return (
    <Select onValueChange={(v) => onBind(v)} disabled={disabled}>
      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="+ Bind device" /></SelectTrigger>
      <SelectContent>
        {available.map((d) => (
          <SelectItem key={d.id} value={d.id}>{d.display_name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewRoleDialog({
  onCreate, pending,
}: {
  onCreate: (input: { code: string; label: string; hardware_kind: string; description: string }) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [hardwareKind, setHardwareKind] = useState("receipt_printer");
  const [description, setDescription] = useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4 mr-1" /> New role</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New printer role</DialogTitle>
          <DialogDescription>
            Roles are shared across all branches. Bindings decide which device
            actually handles the role at each branch.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder="e.g. bar_receipt"
            />
          </div>
          <div>
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Bar receipt printer" />
          </div>
          <div>
            <Label>Hardware kind</Label>
            <Select value={hardwareKind} onValueChange={setHardwareKind}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {HARDWARE_KIND_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={pending || !code || !label}
            onClick={() => {
              onCreate({ code, label, hardware_kind: hardwareKind, description });
              setOpen(false);
              setCode(""); setLabel(""); setDescription("");
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
