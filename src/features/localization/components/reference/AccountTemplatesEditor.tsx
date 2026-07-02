import { normalizeError } from "@/services/resilience";
/**
 * AccountTemplatesEditor — structured CRUD for `localization_pack_account_templates`.
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, AlertTriangle, Lock } from "lucide-react";
import { toast } from "sonner";
import { DeleteImpactDialog } from "./DeleteImpactDialog";
import { LocalizationFormShell } from "../_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";

const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "income", "expense"] as const;
const CASH_FLOW = ["", "operating", "investing", "financing"] as const;

type Row = {
  id: string;
  pack_id: string;
  code: string;
  name: string;
  account_type: string;
  parent_code: string | null;
  description: string | null;
  cash_flow_category: string | null;
  is_system: boolean | null;
  sort_order: number | null;
};

type Draft = Omit<Row, "id" | "pack_id"> & { id?: string };

const empty = (): Draft => ({
  code: "",
  name: "",
  account_type: "asset",
  parent_code: null,
  description: "",
  cash_flow_category: null,
  is_system: false,
  sort_order: 0,
});

export function AccountTemplatesEditor({ packId, readOnly = false }: { packId: string; readOnly?: boolean }) {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["pack-account-templates", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_pack_account_templates")
        .select("*")
        .eq("pack_id", packId)
        .order("code");
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);

  const codeSet = useMemo(() => new Set((rows ?? []).map((r) => r.code)), [rows]);

  const save = useMutation({
    mutationFn: async (input: Draft) => {
      const payload: any = {
        pack_id: packId,
        code: input.code.trim(),
        name: input.name.trim(),
        account_type: input.account_type,
        parent_code: input.parent_code?.trim() || null,
        description: input.description?.trim() || null,
        cash_flow_category: input.cash_flow_category || null,
        is_system: !!input.is_system,
        sort_order: input.sort_order ?? 0,
      };
      if (input.id) {
        const { error } = await (supabase as any).from("localization_pack_account_templates").update(payload).eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from("localization_pack_account_templates").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-account-templates", packId] });
      setDraft(null);
      toast.success("Account saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Save failed"),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("localization_pack_account_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-account-templates", packId] });
      setConfirmDelete(null);
      toast.success("Account deleted");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Delete failed"),
  });

  const errors = useMemo(() => {
    if (!draft) return [];
    const errs: string[] = [];
    const code = draft.code.trim();
    const name = draft.name.trim();
    if (!code) errs.push("Code is required");
    if (!name) errs.push("Name is required");
    if (!draft.account_type) errs.push("Account type is required");
    const dup = (rows ?? []).find((r) => r.code === code && r.id !== draft.id);
    if (dup) errs.push(`Another account already uses code "${code}"`);
    if (draft.parent_code) {
      if (draft.parent_code === code) errs.push("Account cannot be its own parent");
      else if (!codeSet.has(draft.parent_code)) errs.push(`Parent code "${draft.parent_code}" does not exist in this pack`);
    }
    return errs;
  }, [draft, rows, codeSet]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Account templates</CardTitle>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={() => setDraft(empty())}>
            <Plus className="h-3.5 w-3.5 mr-1" />Add account
          </Button>
        )}
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && (rows ?? []).length === 0 && <div className="text-muted-foreground">No accounts yet.</div>}
        {(rows ?? []).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3">Code</th>
                  <th className="py-1.5 pr-3">Name</th>
                  <th className="py-1.5 pr-3">Type</th>
                  <th className="py-1.5 pr-3">Parent</th>
                  <th className="py-1.5 pr-3">Cash flow</th>
                  {!readOnly && <th className="py-1.5 w-20"></th>}
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-mono">{r.code}</td>
                    <td className="py-1.5 pr-3">
                      {r.name}
                      {r.is_system && <Badge variant="secondary" className="ml-2 text-[10px]"><Lock className="h-2.5 w-2.5 mr-1" />system</Badge>}
                    </td>
                    <td className="py-1.5 pr-3">{r.account_type}</td>
                    <td className="py-1.5 pr-3 font-mono text-muted-foreground">{r.parent_code ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{r.cash_flow_category ?? "—"}</td>
                    {!readOnly && (
                      <td className="py-1.5 text-right space-x-1">
                        <Button size="icon" variant="ghost"
                          disabled={!!r.is_system}
                          onClick={() => setDraft({ ...r, description: r.description ?? "" })}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" disabled={!!r.is_system} onClick={() => setConfirmDelete(r)}>
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
        entity="account-template"
        mode={draft?.id ? "edit" : "create"}
        busy={save.isPending}
        submitDisabled={errors.length > 0}
        onSubmit={() => draft && save.mutate(draft)}
      >
        {draft && (
          <>
            <WorkflowSheetSection number={1} title="Identity" subtitle="The account's code and human-readable name.">
              <WorkflowSheetGrid>
                <WorkflowField label="Code" required>
                  <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
                </WorkflowField>
                <WorkflowField label="Type" required>
                  <Select value={draft.account_type} onValueChange={(v) => setDraft({ ...draft, account_type: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{ACCOUNT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                </WorkflowField>
                <WorkflowField label="Name" required className="lg:col-span-2">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </WorkflowField>
                <WorkflowField label="Description" className="lg:col-span-2">
                  <Input value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={2} title="Hierarchy & reporting" subtitle="Where this account sits in the chart and how it surfaces in the cash flow statement.">
              <WorkflowSheetGrid columns={3}>
                <WorkflowField label="Parent code">
                  <Select value={draft.parent_code ?? "__none__"} onValueChange={(v) => setDraft({ ...draft, parent_code: v === "__none__" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— none —</SelectItem>
                      {(rows ?? []).filter((r) => r.code !== draft.code).map((r) => (
                        <SelectItem key={r.id} value={r.code}>{r.code} — {r.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </WorkflowField>
                <WorkflowField label="Cash flow category">
                  <Select value={draft.cash_flow_category ?? "__none__"} onValueChange={(v) => setDraft({ ...draft, cash_flow_category: v === "__none__" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— none —</SelectItem>
                      {CASH_FLOW.filter(Boolean).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </WorkflowField>
                <WorkflowField label="Sort order">
                  <NumericInput value={typeof draft.sort_order === "number" ? draft.sort_order : 0}
                    allowDecimals={false}
                    onValueChange={(n) => setDraft({ ...draft, sort_order: n ?? 0 })} />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={3} title="Advanced" subtitle="System accounts are protected from accidental edits and deletes.">
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-xs font-medium">System (locked)</span>
                <Switch checked={!!draft.is_system} onCheckedChange={(v) => setDraft({ ...draft, is_system: v })} />
              </div>
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
        kind="account"
        rowKey={confirmDelete?.code ?? ""}
        rowLabel={`account "${confirmDelete?.code ?? ""} — ${confirmDelete?.name ?? ""}"`}
        pending={del.isPending}
        onConfirm={() => confirmDelete && del.mutate(confirmDelete.id)}
      />
    </Card>
  );
}
