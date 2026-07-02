import { normalizeError } from "@/services/resilience";
/**
 * TaxTemplatesEditor — structured CRUD for `localization_pack_tax_templates`.
 * Admin-only edit; tenants get a read-only badge from the parent shell.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DeleteImpactDialog } from "./DeleteImpactDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { LocalizationFormShell } from "../_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";

const TAX_TYPES = ["percentage", "fixed", "sales", "purchase", "withholding", "excise", "other"] as const;

type Row = {
  id: string;
  pack_id: string;
  name: string;
  rate: number | null;
  description: string | null;
  tax_type: string | null;
  is_compound: boolean | null;
  is_inclusive: boolean | null;
  is_default: boolean | null;
  sort_order: number | null;
};

type Draft = Omit<Row, "id" | "pack_id"> & { id?: string };

const empty = (): Draft => ({
  name: "",
  rate: 0,
  description: "",
  tax_type: "percentage",
  is_compound: false,
  is_inclusive: false,
  is_default: false,
  sort_order: 0,
});

export function TaxTemplatesEditor({ packId, readOnly = false }: { packId: string; readOnly?: boolean }) {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["pack-tax-templates", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_pack_tax_templates")
        .select("*")
        .eq("pack_id", packId)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("name");
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);

  const save = useMutation({
    mutationFn: async (input: Draft) => {
      const payload: any = {
        pack_id: packId,
        name: input.name.trim(),
        rate: input.rate,
        description: input.description?.trim() || null,
        tax_type: input.tax_type,
        is_compound: !!input.is_compound,
        is_inclusive: !!input.is_inclusive,
        is_default: !!input.is_default,
        sort_order: input.sort_order ?? 0,
      };
      // Enforce single is_default per pack.
      if (payload.is_default) {
        await (supabase as any).from("localization_pack_tax_templates")
          .update({ is_default: false })
          .eq("pack_id", packId)
          .neq("id", input.id ?? "00000000-0000-0000-0000-000000000000");
      }
      if (input.id) {
        const { error } = await (supabase as any).from("localization_pack_tax_templates").update(payload).eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from("localization_pack_tax_templates").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-tax-templates", packId] });
      setDraft(null);
      toast.success("Tax saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Save failed"),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("localization_pack_tax_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-tax-templates", packId] });
      setConfirmDelete(null);
      toast.success("Tax deleted");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Delete failed"),
  });

  const errors = useMemo(() => {
    if (!draft) return [];
    const errs: string[] = [];
    const name = draft.name.trim();
    if (!name) errs.push("Name is required");
    const rate = Number(draft.rate ?? 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) errs.push("Rate must be between 0 and 100");
    const dup = (rows ?? []).find((r) => r.name.trim().toLowerCase() === name.toLowerCase() && r.id !== draft.id);
    if (dup) errs.push(`Another tax already uses the name "${name}"`);
    return errs;
  }, [draft, rows]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Tax templates</CardTitle>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={() => setDraft(empty())}>
            <Plus className="h-3.5 w-3.5 mr-1" />Add tax
          </Button>
        )}
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && (rows ?? []).length === 0 && <div className="text-muted-foreground">No taxes yet.</div>}
        {(rows ?? []).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3">Name</th>
                  <th className="py-1.5 pr-3">Type</th>
                  <th className="py-1.5 pr-3 text-right">Rate %</th>
                  <th className="py-1.5 pr-3">Flags</th>
                  <th className="py-1.5 pr-3 text-right">Order</th>
                  {!readOnly && <th className="py-1.5 w-20"></th>}
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{r.name}</td>
                    <td className="py-1.5 pr-3">{r.tax_type ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.rate ?? 0}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">
                      {[r.is_default && "default", r.is_compound && "compound", r.is_inclusive && "inclusive"]
                        .filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.sort_order ?? 0}</td>
                    {!readOnly && (
                      <td className="py-1.5 text-right space-x-1">
                        <Button size="icon" variant="ghost" onClick={() => setDraft({ ...r, description: r.description ?? "" })}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => setConfirmDelete(r)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <LocalizationFormShell
        open={!!draft}
        onOpenChange={(o) => !o && setDraft(null)}
        entity="tax-template"
        mode={draft?.id ? "edit" : "create"}
        busy={save.isPending}
        submitDisabled={errors.length > 0}
        onSubmit={() => draft && save.mutate(draft)}
      >
        {draft && (
          <>
            <WorkflowSheetSection number={1} title="Identity" subtitle="How this tax surfaces across the product.">
              <WorkflowSheetGrid>
                <WorkflowField label="Name" required className="lg:col-span-2">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </WorkflowField>
                <WorkflowField label="Description" className="lg:col-span-2">
                  <Input value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={2} title="Computation" subtitle="Tax type, rate, and ordering for compound stacks.">
              <WorkflowSheetGrid columns={3}>
                <WorkflowField label="Type">
                  <Select value={draft.tax_type ?? "percentage"} onValueChange={(v) => setDraft({ ...draft, tax_type: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TAX_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </WorkflowField>
                <WorkflowField label="Rate (%)">
                  <NumericInput min={0} max={100} step={0.01}
                    value={typeof draft.rate === "number" ? draft.rate : null}
                    onValueChange={(n) => setDraft({ ...draft, rate: n ?? 0 })} />
                </WorkflowField>
                <WorkflowField label="Sort order">
                  <NumericInput value={typeof draft.sort_order === "number" ? draft.sort_order : 0}
                    allowDecimals={false}
                    onValueChange={(n) => setDraft({ ...draft, sort_order: n ?? 0 })} />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={3} title="Behaviour flags" subtitle="Defaulting and compounding rules.">
              <WorkflowSheetGrid columns={3}>
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span className="text-xs font-medium">Default</span>
                  <Switch checked={!!draft.is_default} onCheckedChange={(v) => setDraft({ ...draft, is_default: v })} />
                </div>
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span className="text-xs font-medium">Compound</span>
                  <Switch checked={!!draft.is_compound} onCheckedChange={(v) => setDraft({ ...draft, is_compound: v })} />
                </div>
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span className="text-xs font-medium">Price-inclusive</span>
                  <Switch checked={!!draft.is_inclusive} onCheckedChange={(v) => setDraft({ ...draft, is_inclusive: v })} />
                </div>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            {errors.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{errors.map((e, i) => <div key={i}>{e}</div>)}</AlertDescription>
              </Alert>
            )}
          </>
        )}
      </LocalizationFormShell>

      <DeleteImpactDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        packId={packId}
        kind="tax"
        rowKey={confirmDelete?.name ?? ""}
        rowLabel={`tax "${confirmDelete?.name ?? ""}"`}
        pending={del.isPending}
        onConfirm={() => confirmDelete && del.mutate(confirmDelete.id)}
      />
    </Card>
  );
}
