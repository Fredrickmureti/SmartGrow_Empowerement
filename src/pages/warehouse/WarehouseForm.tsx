/**
 * Shared Warehouse create/edit form.
 *
 * Rendered inside `RecordFormShell` on the routed `/warehouses/new` and
 * `/warehouses/:id/edit` surfaces. Uses `useWarehouses` for persistence.
 * Preserves the branch-scoping rule enforced by the legacy dialog: in
 * multi-branch orgs the branch is required; in single-branch orgs it
 * defaults to the active branch and is not surfaced.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useWarehouses, type Warehouse } from "@/hooks/useWarehouses";
import { useBranches } from "@/hooks/useBranches";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";

interface WarehouseFormProps {
  mode: "create" | "edit";
  warehouse?: Warehouse | null;
}

export function WarehouseForm({ mode, warehouse }: WarehouseFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { createWarehouse, updateWarehouse } = useWarehouses();
  const { branches, currentBranch } = useBranches();

  const [form, setForm] = useState({
    name: "",
    code: "",
    address: "",
    city: "",
    country: "",
    is_default: false,
    branch_id: "" as string,
    manager_name: "",
    manager_email: "",
    manager_phone: "",
    is_active: true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Seed from existing warehouse on edit, or from active branch on create.
  useEffect(() => {
    if (mode === "edit" && warehouse) {
      setForm({
        name: warehouse.name,
        code: warehouse.code || "",
        address: warehouse.address || "",
        city: warehouse.city || "",
        country: warehouse.country || "",
        is_default: warehouse.is_default,
        branch_id: warehouse.branch_id ?? "",
        manager_name: warehouse.manager_name || "",
        manager_email: warehouse.manager_email || "",
        manager_phone: warehouse.manager_phone || "",
        is_active: warehouse.is_active,
      });
    } else if (mode === "create" && currentBranch) {
      setForm((f) => ({ ...f, branch_id: f.branch_id || currentBranch.id }));
    }
  }, [mode, warehouse, currentBranch]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (branches.length > 1 && !form.branch_id) {
      toast({
        title: "Branch required",
        description: "Pick the branch that owns this warehouse.",
        variant: "destructive",
      });
      return;
    }
    setIsSubmitting(true);
    try {
      const data = {
        name: form.name,
        code: form.code,
        address: form.address || null,
        city: form.city || null,
        country: form.country || null,
        is_default: form.is_default,
        branch_id: form.branch_id || currentBranch?.id || null,
        manager_name: form.manager_name || null,
        manager_email: form.manager_email || null,
        manager_phone: form.manager_phone || null,
        is_active: form.is_active,
      };
      if (mode === "edit" && warehouse) {
        await updateWarehouse(warehouse.id, data);
        toast({ title: "Warehouse updated successfully" });
      } else {
        await createWarehouse(data);
        toast({ title: "Warehouse created successfully" });
      }
      navigate("/warehouse-app/warehouses");
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode={mode}
      entityLabel="Warehouse"
      recordRef={mode === "edit" ? warehouse?.name : undefined}
      cancelHref="/warehouse-app/warehouses"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!form.name}
    >
      <Section title="Details" description="Where this warehouse lives.">
        <FieldGrid columns={2}>
          {branches.length > 1 && (
            <FieldCell span={2}>
              <div className="space-y-2">
                <Label htmlFor="wh_branch">Branch *</Label>
                <Select
                  value={form.branch_id}
                  onValueChange={(v) => setForm((f) => ({ ...f, branch_id: v }))}
                >
                  <SelectTrigger id="wh_branch">
                    <SelectValue placeholder="Pick the branch that owns this warehouse" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  A warehouse lives in exactly one branch — its stock cannot
                  leak to other branches.
                </p>
              </div>
            </FieldCell>
          )}
          <div className="space-y-2">
            <Label htmlFor="wh_name">Name *</Label>
            <Input
              id="wh_name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wh_code">Code</Label>
            <Input
              id="wh_code"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            />
          </div>
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="wh_address">Address</Label>
              <Input
                id="wh_address"
                value={form.address}
                onChange={(e) =>
                  setForm((f) => ({ ...f, address: e.target.value }))
                }
              />
            </div>
          </FieldCell>
          <div className="space-y-2">
            <Label htmlFor="wh_city">City</Label>
            <Input
              id="wh_city"
              value={form.city}
              onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wh_country">Country</Label>
            <Input
              id="wh_country"
              value={form.country}
              onChange={(e) =>
                setForm((f) => ({ ...f, country: e.target.value }))
              }
            />
          </div>
        </FieldGrid>
      </Section>

      <Section
        title="Manager"
        description="Optional point of contact for this location."
      >
        <FieldGrid columns={3}>
          <div className="space-y-2">
            <Label htmlFor="wh_mgr_name">Manager Name</Label>
            <Input
              id="wh_mgr_name"
              value={form.manager_name}
              onChange={(e) =>
                setForm((f) => ({ ...f, manager_name: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wh_mgr_email">Manager Email</Label>
            <Input
              id="wh_mgr_email"
              type="email"
              value={form.manager_email}
              onChange={(e) =>
                setForm((f) => ({ ...f, manager_email: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wh_mgr_phone">Manager Phone</Label>
            <Input
              id="wh_mgr_phone"
              value={form.manager_phone}
              onChange={(e) =>
                setForm((f) => ({ ...f, manager_phone: e.target.value }))
              }
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Status">
        <FieldGrid columns={2}>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="wh_default">Default warehouse</Label>
              <p className="text-xs text-muted-foreground">
                New stock defaults to this location.
              </p>
            </div>
            <Switch
              id="wh_default"
              checked={form.is_default}
              onCheckedChange={(v) =>
                setForm((f) => ({ ...f, is_default: v }))
              }
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="wh_active">Active</Label>
              <p className="text-xs text-muted-foreground">
                Inactive warehouses are hidden from pickers.
              </p>
            </div>
            <Switch
              id="wh_active"
              checked={form.is_active}
              onCheckedChange={(v) =>
                setForm((f) => ({ ...f, is_active: v }))
              }
            />
          </div>
        </FieldGrid>
      </Section>
    </RecordFormShell>
  );
}