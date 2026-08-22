/**
 * Variable Input Types — tenant editor for `public.payroll_input_types`.
 *
 * Mounted at `/hr/payroll/configuration/input-types`. Each row is a
 * per-run input slot rendered as a column in the payroll-create
 * "Variable Inputs" grid. Before this page existed the registry could
 * only be seeded with raw SQL, so the grid always showed its empty
 * state.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useSalaryStructures } from "@/hooks/useSalaryStructures";
import type { PayrollInputType, PayrollInputUnit } from "@/hooks/payroll/useVariableInputTypes";
import {
  useVariableInputTypeMutations,
  validateInputTypeDraft,
  type PayrollInputTypeDraft,
} from "@/hooks/payroll/useVariableInputTypeMutations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Sparkles, Trash2, Pencil, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

const UNITS: { value: PayrollInputUnit; label: string; hint: string }[] = [
  { value: "amount", label: "Amount", hint: "A cash figure entered per employee." },
  { value: "hours", label: "Hours", hint: "Hours worked; priced by the matching rule." },
  { value: "days", label: "Days", hint: "Days counted; priced by the matching rule." },
  { value: "count", label: "Count", hint: "A plain quantity (units, trips, shifts…)." },
];

function emptyDraft(): PayrollInputTypeDraft {
  return {
    business_id: null,
    code: "",
    name: "",
    description: null,
    input_unit: "amount",
    default_value: null,
    min_value: null,
    max_value: null,
    is_required: false,
    structure_ids: [],
    is_active: true,
    sequence: 100,
  };
}

function toDraft(row: PayrollInputType): PayrollInputTypeDraft {
  return {
    id: row.id,
    business_id: row.business_id,
    code: row.code,
    name: row.name,
    description: row.description,
    input_unit: row.input_unit,
    default_value: row.default_value,
    min_value: row.min_value,
    max_value: row.max_value,
    is_required: row.is_required,
    structure_ids: row.structure_ids ?? [],
    is_active: row.is_active,
    sequence: row.sequence,
  };
}

/** Every row for the org, active or not — the editor must show both. */
function useAllInputTypes() {
  const { currentOrg } = useOrganization();
  return useQuery({
    queryKey: ["payroll-input-types", "admin", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<PayrollInputType[]> => {
      const { data, error } = await supabase
        .from("payroll_input_types" as any)
        .select(
          "id, organization_id, business_id, code, name, description, input_unit, default_value, min_value, max_value, is_required, structure_ids, is_active, sequence",
        )
        .eq("organization_id", currentOrg!.id)
        .order("sequence", { ascending: true });
      if (error) throw error;
      return ((data || []) as unknown as PayrollInputType[]).map((r) => ({
        ...r,
        structure_ids: r.structure_ids ?? [],
      }));
    },
  });
}

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

export default function VariableInputTypes() {
  const { data: rows = [], isLoading } = useAllInputTypes();
  const { currentBusiness } = useBusinesses();
  const { structures } = useSalaryStructures();
  const { upsert, setActive, remove, seedStarterSet } = useVariableInputTypeMutations();

  const [draft, setDraft] = useState<PayrollInputTypeDraft | null>(null);
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PayrollInputType | null>(null);

  const activeCount = useMemo(() => rows.filter((r) => r.is_active).length, [rows]);

  const startNew = () => { setDraft(emptyDraft()); setOpen(true); };
  const startEdit = (row: PayrollInputType) => { setDraft(toDraft(row)); setOpen(true); };

  const save = async () => {
    if (!draft) return;
    const problem = validateInputTypeDraft(draft, rows);
    if (problem) { toast.error(problem); return; }
    await upsert.mutateAsync(draft);
    setOpen(false);
  };

  const patch = (p: Partial<PayrollInputTypeDraft>) =>
    setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            to="/hr/payroll/configuration"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> Configuration
          </Link>
          <h1 className="text-2xl font-semibold mt-1">Variable Input Types</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Slots your team can fill in per employee on each payroll run — overtime, bonus,
            commission and anything else that changes period to period. Each one becomes a
            column in the run's <b>Variable Inputs</b> grid.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {rows.length === 0 && !isLoading && (
            <Button variant="outline" onClick={() => seedStarterSet.mutate({})} disabled={seedStarterSet.isPending}>
              <Sparkles className="mr-2 h-4 w-4" /> Add standard inputs
            </Button>
          )}
          <Button onClick={startNew}><Plus className="mr-2 h-4 w-4" /> New input</Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">No variable inputs yet.</p>
            <p>
              Use <b>Add standard inputs</b> to install the common set (overtime, overtime hours,
              bonus, commission, arrears) — all recognised by the payroll engine — or create your
              own with <b>New input</b>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Seq</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="text-right">Default</TableHead>
                  <TableHead className="text-right">Min</TableHead>
                  <TableHead className="text-right">Max</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Structures</TableHead>
                  <TableHead className="text-center">Required</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className={r.is_active ? "" : "opacity-60"}>
                    <TableCell className="text-xs text-muted-foreground">{r.sequence}</TableCell>
                    <TableCell className="font-medium">
                      {r.name}
                      {r.description && (
                        <span className="block text-xs text-muted-foreground">{r.description}</span>
                      )}
                    </TableCell>
                    <TableCell><code className="text-xs">{r.code}</code></TableCell>
                    <TableCell className="text-xs">{r.input_unit}</TableCell>
                    <TableCell className="text-right text-xs">{r.default_value ?? "—"}</TableCell>
                    <TableCell className="text-right text-xs">{r.min_value ?? "—"}</TableCell>
                    <TableCell className="text-right text-xs">{r.max_value ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={r.business_id ? "default" : "secondary"} className="font-normal">
                        {r.business_id ? "This business" : "Organization"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.structure_ids.length === 0
                        ? "All"
                        : `${r.structure_ids.length} selected`}
                    </TableCell>
                    <TableCell className="text-center text-xs">{r.is_required ? "Yes" : "—"}</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={r.is_active}
                        onCheckedChange={(v) => setActive.mutate({ id: r.id, is_active: v })}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => startEdit(r)} aria-label={`Edit ${r.name}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setPendingDelete(r)} aria-label={`Delete ${r.name}`}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {activeCount} active of {rows.length}. Deactivating keeps historical runs intact;
          deleting removes the slot entirely.
        </p>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{draft?.id ? "Edit variable input" : "New variable input"}</SheetTitle>
          </SheetHeader>
          {draft && (
            <div className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="Overtime"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Code</Label>
                  <Input
                    value={draft.code}
                    onChange={(e) => patch({ code: e.target.value.toLowerCase().replace(/\s+/g, "_") })}
                    placeholder="overtime_amount"
                    disabled={!!draft.id}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {draft.id
                      ? "Codes are fixed once created — historical runs reference them."
                      : "Lowercase letters, digits and underscores. The payroll engine looks up this key."}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Description</Label>
                <Textarea
                  value={draft.description ?? ""}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder="Shown as a tooltip on the payroll run grid."
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Unit</Label>
                  <Select
                    value={draft.input_unit}
                    onValueChange={(v) => patch({ input_unit: v as PayrollInputUnit })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {UNITS.map((u) => (
                        <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    {UNITS.find((u) => u.value === draft.input_unit)?.hint}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Sequence</Label>
                  <Input
                    type="number"
                    value={draft.sequence}
                    onChange={(e) => patch({ sequence: Number(e.target.value) || 0 })}
                  />
                  <p className="text-[11px] text-muted-foreground">Column order, lowest first.</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>Default</Label>
                  <Input
                    type="number"
                    value={draft.default_value ?? ""}
                    onChange={(e) => patch({ default_value: num(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Minimum</Label>
                  <Input
                    type="number"
                    value={draft.min_value ?? ""}
                    onChange={(e) => patch({ min_value: num(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Maximum</Label>
                  <Input
                    type="number"
                    value={draft.max_value ?? ""}
                    onChange={(e) => patch({ max_value: num(e.target.value) })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Scope</Label>
                <Select
                  value={draft.business_id ? "business" : "org"}
                  onValueChange={(v) =>
                    patch({ business_id: v === "business" ? currentBusiness?.id ?? null : null })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="org">Whole organization</SelectItem>
                    <SelectItem value="business" disabled={!currentBusiness?.id}>
                      {currentBusiness?.name ? `Only ${currentBusiness.name}` : "Only this business"}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  A business-scoped input with the same code overrides the organization-wide one.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Salary structures</Label>
                <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1.5">
                  {structures.length === 0 && (
                    <p className="text-xs text-muted-foreground">No salary structures defined.</p>
                  )}
                  {structures.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={draft.structure_ids.includes(s.id)}
                        onCheckedChange={(v) =>
                          patch({
                            structure_ids: v
                              ? [...draft.structure_ids, s.id]
                              : draft.structure_ids.filter((x) => x !== s.id),
                          })
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Leave all unchecked to apply to every structure.
                </p>
              </div>

              <div className="flex items-center justify-between border rounded-md p-3">
                <div>
                  <Label className="text-sm">Required</Label>
                  <p className="text-[11px] text-muted-foreground">Flagged on the run grid when left blank.</p>
                </div>
                <Switch checked={draft.is_required} onCheckedChange={(v) => patch({ is_required: v })} />
              </div>

              <div className="flex items-center justify-between border rounded-md p-3">
                <div>
                  <Label className="text-sm">Active</Label>
                  <p className="text-[11px] text-muted-foreground">Inactive inputs stay out of new runs.</p>
                </div>
                <Switch checked={draft.is_active} onCheckedChange={(v) => patch({ is_active: v })} />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={save} disabled={upsert.isPending}>Save</Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pendingDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the input slot entirely. If it has been used on past runs, deactivate
              it instead so historical payslips keep their meaning.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) remove.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
