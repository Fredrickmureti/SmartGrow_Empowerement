import { normalizeError } from "@/services/resilience";
/**
 * RemittanceSchedulesEditor — structured CRUD for `localization_pack_remittance_schedules`.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { DeleteImpactDialog } from "./DeleteImpactDialog";
import { LocalizationFormShell } from "../_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";

const FREQUENCIES = ["monthly", "quarterly", "annually"] as const;

type Row = {
  id: string;
  pack_id: string;
  rule_code: string;
  authority_name: string | null;
  frequency: string;
  due_day: number | null;
  due_month: number | null;
  liability_account_setting_key: string | null;
};

type Draft = Omit<Row, "id" | "pack_id"> & { id?: string };

const empty = (): Draft => ({
  rule_code: "",
  authority_name: "",
  frequency: "monthly",
  due_day: 9,
  due_month: null,
  liability_account_setting_key: "",
});

export function RemittanceSchedulesEditor({ packId, readOnly = false }: { packId: string; readOnly?: boolean }) {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["pack-remittance-schedules", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_pack_remittance_schedules")
        .select("*")
        .eq("pack_id", packId)
        .order("rule_code");
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const { data: ruleCodes } = useQuery({
    queryKey: ["pack-rule-codes", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_pack_payroll_templates")
        .select("rule_code")
        .eq("pack_id", packId);
      if (error) throw error;
      const set = new Set<string>((data ?? []).map((r: any) => r.rule_code).filter(Boolean));
      return Array.from(set).sort();
    },
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);

  const save = useMutation({
    mutationFn: async (input: Draft) => {
      const payload: any = {
        pack_id: packId,
        rule_code: input.rule_code.trim(),
        authority_name: input.authority_name?.trim() || null,
        frequency: input.frequency,
        due_day: input.due_day,
        due_month: input.frequency === "annually" ? input.due_month : null,
        liability_account_setting_key: input.liability_account_setting_key?.trim() || null,
      };
      if (input.id) {
        const { error } = await (supabase as any).from("localization_pack_remittance_schedules").update(payload).eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from("localization_pack_remittance_schedules").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-remittance-schedules", packId] });
      setDraft(null);
      toast.success("Schedule saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Save failed"),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("localization_pack_remittance_schedules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-remittance-schedules", packId] });
      setConfirmDelete(null);
      toast.success("Schedule deleted");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Delete failed"),
  });

  const { errors, warnings } = useMemo(() => {
    const errs: string[] = [];
    const warns: string[] = [];
    if (!draft) return { errors: errs, warnings: warns };
    if (!draft.rule_code.trim()) errs.push("Rule code is required");
    if (!draft.frequency) errs.push("Frequency is required");
    if (draft.due_day == null || draft.due_day < 1 || draft.due_day > 31) errs.push("Due day must be between 1 and 31");
    if (draft.frequency === "annually" && (draft.due_month == null || draft.due_month < 1 || draft.due_month > 12)) {
      errs.push("Annual schedules require a due month between 1 and 12");
    }
    if ((ruleCodes ?? []).length > 0 && draft.rule_code && !ruleCodes!.includes(draft.rule_code)) {
      warns.push(`Rule code "${draft.rule_code}" is not defined as a payroll template in this pack`);
    }
    return { errors: errs, warnings: warns };
  }, [draft, ruleCodes]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Remittance schedules</CardTitle>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={() => setDraft(empty())}>
            <Plus className="h-3.5 w-3.5 mr-1" />Add schedule
          </Button>
        )}
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && (rows ?? []).length === 0 && <div className="text-muted-foreground">No schedules yet.</div>}
        {(rows ?? []).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3">Rule</th>
                  <th className="py-1.5 pr-3">Authority</th>
                  <th className="py-1.5 pr-3">Frequency</th>
                  <th className="py-1.5 pr-3 text-right">Due</th>
                  <th className="py-1.5 pr-3">Liability key</th>
                  {!readOnly && <th className="py-1.5 w-20"></th>}
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-mono">{r.rule_code}</td>
                    <td className="py-1.5 pr-3">{r.authority_name ?? "—"}</td>
                    <td className="py-1.5 pr-3">{r.frequency}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {r.frequency === "annually" ? `m${r.due_month ?? "?"}/d${r.due_day ?? "?"}` : `d${r.due_day ?? "?"}`}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-muted-foreground">{r.liability_account_setting_key ?? "—"}</td>
                    {!readOnly && (
                      <td className="py-1.5 text-right space-x-1">
                        <Button size="icon" variant="ghost" onClick={() => setDraft({ ...r, authority_name: r.authority_name ?? "", liability_account_setting_key: r.liability_account_setting_key ?? "" })}>
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
        entity="remittance-schedule"
        mode={draft?.id ? "edit" : "create"}
        busy={save.isPending}
        submitDisabled={errors.length > 0}
        onSubmit={() => draft && save.mutate(draft)}
      >
        {draft && (
          <>
            <WorkflowSheetSection number={1} title="Schedule identity" subtitle="Which payroll rule this remittance covers and who it pays.">
              <WorkflowSheetGrid>
                <WorkflowField label="Rule code" required>
                  {(ruleCodes ?? []).length > 0 ? (
                    <Select value={draft.rule_code} onValueChange={(v) => setDraft({ ...draft, rule_code: v })}>
                      <SelectTrigger><SelectValue placeholder="Select rule code" /></SelectTrigger>
                      <SelectContent>
                        {ruleCodes!.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input value={draft.rule_code} onChange={(e) => setDraft({ ...draft, rule_code: e.target.value })} />
                  )}
                </WorkflowField>
                <WorkflowField label="Authority name" hint="The tax authority or regulator receiving this remittance.">
                  <Input
                    value={draft.authority_name ?? ""}
                    onChange={(e) => setDraft({ ...draft, authority_name: e.target.value })}
                    placeholder="e.g. KRA, HMRC, IRS"
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={2} title="Cadence & due date" subtitle="When the engine schedules the next remittance.">
              <WorkflowSheetGrid columns={3}>
                <WorkflowField label="Frequency" required>
                  <Select
                    value={draft.frequency}
                    onValueChange={(v) =>
                      setDraft({ ...draft, frequency: v, due_month: v === "annually" ? draft.due_month ?? 1 : null })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent>
                  </Select>
                </WorkflowField>
                <WorkflowField label="Due day" required hint="Day of the month, 1–31.">
                  <NumericInput
                    min={1} max={31} allowDecimals={false}
                    value={typeof draft.due_day === "number" ? draft.due_day : null}
                    onValueChange={(n) => setDraft({ ...draft, due_day: n })}
                  />
                </WorkflowField>
                <WorkflowField label="Due month" hint="Annual schedules only, 1–12.">
                  <NumericInput
                    min={1} max={12} allowDecimals={false}
                    value={typeof draft.due_month === "number" ? draft.due_month : null}
                    disabled={draft.frequency !== "annually"}
                    onValueChange={(n) => setDraft({ ...draft, due_month: n })}
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={3} title="Accounting" subtitle="Where the liability accrues until it is paid out.">
              <WorkflowField label="Liability account setting key" hint="Setting key resolved per tenant to a real GL account.">
                <Input
                  value={draft.liability_account_setting_key ?? ""}
                  placeholder="e.g. paye_payable_account_id"
                  onChange={(e) => setDraft({ ...draft, liability_account_setting_key: e.target.value })}
                />
              </WorkflowField>
            </WorkflowSheetSection>

            {warnings.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{warnings.map((w, i) => <div key={i}>{w}</div>)}</AlertDescription>
              </Alert>
            )}
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
        kind="remittance"
        rowKey={confirmDelete?.rule_code ?? ""}
        rowLabel={`remittance schedule "${confirmDelete?.rule_code ?? ""}"`}
        pending={del.isPending}
        onConfirm={() => confirmDelete && del.mutate(confirmDelete.id)}
      />
    </Card>
  );
}
