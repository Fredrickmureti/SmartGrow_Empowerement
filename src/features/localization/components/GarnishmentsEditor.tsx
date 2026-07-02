/**
 * GarnishmentsEditor — manages a pack's garnishment kinds + the policy row
 * that governs how multiple orders interact.
 *
 * Tables:
 *   - `localization_pack_garnishment_kinds`   : one row per statutory order
 *     type (child_support, tax_levy, court_order, …).
 *   - `localization_pack_garnishment_policies`: typically a single row per
 *     pack with `policy_key='default'` describing aggregate caps and
 *     priority resolution. We expose it as a singleton editor; advanced
 *     packs with multiple keys can still create extras via the JSON view.
 *
 * Why this matters: until now, kinds and policies were SQL-only. Without
 * them, the garnishment engine has no rules to enforce in this country —
 * publishers literally cannot ship a complete pack.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NumericInput } from "@/components/ui/numeric-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Trash2, Scale } from "lucide-react";
import { toast } from "sonner";
import { LocalizationFormShell } from "./_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { normalizeError } from "@/services/resilience";

const PRIORITY_RESOLUTIONS = [
  "always_first_then_priority_then_date",
  "priority_then_date",
  "date_then_priority",
] as const;

interface KindRow {
  id: string;
  pack_id: string;
  code: string;
  label: string;
  default_priority: number;
  always_first: boolean;
  counts_toward_aggregate_cap: boolean;
  max_concurrent: number | null;
  employer_fee_amount: number;
  employer_fee_account_role: string | null;
  required_identifiers: string[];
  evidence_required: boolean;
  description: string | null;
  is_active: boolean;
}

interface PolicyRow {
  id?: string;
  pack_id: string;
  policy_key: string;
  aggregate_cap_pct: number | null;
  min_take_home_amount: number | null;
  min_take_home_pct: number | null;
  disposable_income_excludes: string[];
  priority_resolution: string;
  protected_earnings_formula_token: string | null;
  notes: string | null;
}

const EMPTY_KIND = (pack_id: string): KindRow => ({
  id: "",
  pack_id,
  code: "",
  label: "",
  default_priority: 100,
  always_first: false,
  counts_toward_aggregate_cap: true,
  max_concurrent: null,
  employer_fee_amount: 0,
  employer_fee_account_role: null,
  required_identifiers: [],
  evidence_required: true,
  description: null,
  is_active: true,
});

const EMPTY_POLICY = (pack_id: string): PolicyRow => ({
  pack_id,
  policy_key: "default",
  aggregate_cap_pct: null,
  min_take_home_amount: null,
  min_take_home_pct: null,
  disposable_income_excludes: [],
  priority_resolution: "always_first_then_priority_then_date",
  protected_earnings_formula_token: null,
  notes: null,
});

export function GarnishmentsEditor({ packId }: { packId: string | null }) {
  if (!packId) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Select a pack to manage garnishments.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      <PolicyCard packId={packId} />
      <KindsCard packId={packId} />
    </div>
  );
}

// ── Kinds ─────────────────────────────────────────────────────────────────

function KindsCard({ packId }: { packId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["pack-garnishment-kinds", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_pack_garnishment_kinds")
        .select("*")
        .eq("pack_id", packId)
        .order("default_priority", { ascending: true })
        .order("code");
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        ...r,
        required_identifiers: Array.isArray(r.required_identifiers) ? r.required_identifiers : [],
      })) as KindRow[];
    },
  });

  const [draft, setDraft] = useState<KindRow | null>(null);
  const [requiredIdsText, setRequiredIdsText] = useState("");

  useEffect(() => {
    setRequiredIdsText((draft?.required_identifiers ?? []).join(", "));
  }, [draft?.id]);

  const save = useMutation({
    mutationFn: async (input: KindRow) => {
      const required = requiredIdsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const payload: any = {
        pack_id: packId,
        code: input.code.trim(),
        label: input.label.trim(),
        default_priority: input.default_priority,
        always_first: input.always_first,
        counts_toward_aggregate_cap: input.counts_toward_aggregate_cap,
        max_concurrent: input.max_concurrent,
        employer_fee_amount: input.employer_fee_amount,
        employer_fee_account_role: input.employer_fee_account_role?.trim() || null,
        required_identifiers: required,
        evidence_required: input.evidence_required,
        description: input.description?.trim() || null,
        is_active: input.is_active,
      };
      if (input.id) {
        const { error } = await (supabase as any)
          .from("localization_pack_garnishment_kinds").update(payload).eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("localization_pack_garnishment_kinds").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-garnishment-kinds", packId] });
      setDraft(null);
      toast.success("Garnishment kind saved");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("localization_pack_garnishment_kinds").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-garnishment-kinds", packId] });
      toast.success("Kind deleted");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm flex items-center gap-2">
            <Scale className="h-4 w-4" /> Garnishment kinds
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Statutory order types the garnishment engine will accept for this country. Priority controls deduction order; lower = earlier.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setDraft(EMPTY_KIND(packId))}>
          <Plus className="h-3.5 w-3.5 mr-1" /> New kind
        </Button>
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && (data ?? []).length === 0 && (
          <div className="text-muted-foreground py-4">
            No garnishment kinds yet. The engine will reject every order until at least one kind exists.
          </div>
        )}
        {(data ?? []).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3">Code</th>
                  <th className="py-1.5 pr-3">Label</th>
                  <th className="py-1.5 pr-3 text-right">Priority</th>
                  <th className="py-1.5 pr-3">Flags</th>
                  <th className="py-1.5 pr-3 text-right">Fee</th>
                  <th className="py-1.5 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-mono">{r.code}</td>
                    <td className="py-1.5 pr-3">{r.label}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.default_priority}</td>
                    <td className="py-1.5 pr-3 space-x-1">
                      {r.always_first && <Badge variant="outline" className="text-[10px]">always first</Badge>}
                      {!r.counts_toward_aggregate_cap && <Badge variant="outline" className="text-[10px]">outside cap</Badge>}
                      {!r.evidence_required && <Badge variant="outline" className="text-[10px]">no evidence</Badge>}
                      {!r.is_active && <Badge variant="destructive" className="text-[10px]">inactive</Badge>}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{Number(r.employer_fee_amount).toFixed(2)}</td>
                    <td className="py-1.5 text-right space-x-1">
                      <Button size="icon" variant="ghost" onClick={() => setDraft(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => {
                          if (confirm(`Delete kind "${r.code}"?`)) del.mutate(r.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
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
        entity="garnishment-kind"
        mode={draft?.id ? "edit" : "create"}
        busy={save.isPending}
        submitDisabled={!draft?.code?.trim() || !draft?.label?.trim()}
        onSubmit={() => draft && save.mutate(draft)}
      >
        {draft && (
          <>
            <WorkflowSheetSection number={1} title="Identity" subtitle="Stable code used by the engine; label shown to payroll officers.">
              <WorkflowSheetGrid>
                <WorkflowField label="Code" required>
                  <Input
                    value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                    placeholder="child_support"
                    className="font-mono"
                  />
                </WorkflowField>
                <WorkflowField label="Label" required>
                  <Input
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    placeholder="Child support order"
                  />
                </WorkflowField>
                <WorkflowField label="Description" hint="Shown in the order-entry UI.">
                  <Textarea
                    value={draft.description ?? ""}
                    rows={2}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={2} title="Priority & limits" subtitle="Resolution order when an employee carries multiple orders.">
              <WorkflowSheetGrid columns={3}>
                <WorkflowField label="Default priority" required hint="Lower = deducted first.">
                  <NumericInput
                    min={1} max={9999} allowDecimals={false}
                    value={draft.default_priority}
                    onValueChange={(n) => setDraft({ ...draft, default_priority: n ?? 100 })}
                  />
                </WorkflowField>
                <WorkflowField label="Max concurrent" hint="Cap on simultaneous active orders of this kind per employee.">
                  <NumericInput
                    min={1} max={20} allowDecimals={false}
                    value={draft.max_concurrent}
                    onValueChange={(n) => setDraft({ ...draft, max_concurrent: n })}
                  />
                </WorkflowField>
                <WorkflowField label="Employer fee">
                  <NumericInput
                    min={0}
                    value={draft.employer_fee_amount}
                    onValueChange={(n) => setDraft({ ...draft, employer_fee_amount: n ?? 0 })}
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.always_first}
                    onCheckedChange={(v) => setDraft({ ...draft, always_first: !!v })}
                  />
                  Always deducted first
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.counts_toward_aggregate_cap}
                    onCheckedChange={(v) => setDraft({ ...draft, counts_toward_aggregate_cap: !!v })}
                  />
                  Counts toward aggregate cap
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.evidence_required}
                    onCheckedChange={(v) => setDraft({ ...draft, evidence_required: !!v })}
                  />
                  Evidence document required
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.is_active}
                    onCheckedChange={(v) => setDraft({ ...draft, is_active: !!v })}
                  />
                  Active
                </label>
              </div>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={3} title="Accounting & compliance">
              <WorkflowSheetGrid>
                <WorkflowField label="Employer fee account role" hint="System account role used to post the employer fee.">
                  <Input
                    value={draft.employer_fee_account_role ?? ""}
                    placeholder="garnishment_employer_fee"
                    onChange={(e) => setDraft({ ...draft, employer_fee_account_role: e.target.value })}
                    className="font-mono"
                  />
                </WorkflowField>
                <WorkflowField label="Required identifiers" hint="Comma-separated: e.g. court_case_no, recipient_account">
                  <Input
                    value={requiredIdsText}
                    onChange={(e) => setRequiredIdsText(e.target.value)}
                    placeholder="court_case_no, recipient_account"
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>
          </>
        )}
      </LocalizationFormShell>
    </Card>
  );
}

// ── Policy (singleton) ────────────────────────────────────────────────────

function PolicyCard({ packId }: { packId: string }) {
  const qc = useQueryClient();
  const { data: row, isLoading } = useQuery({
    queryKey: ["pack-garnishment-policy", packId, "default"],
    queryFn: async (): Promise<PolicyRow | null> => {
      const { data, error } = await (supabase as any)
        .from("localization_pack_garnishment_policies")
        .select("*")
        .eq("pack_id", packId)
        .eq("policy_key", "default")
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        ...data,
        disposable_income_excludes: Array.isArray(data.disposable_income_excludes) ? data.disposable_income_excludes : [],
      } as PolicyRow;
    },
  });

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PolicyRow | null>(null);
  const [excludesText, setExcludesText] = useState("");

  useEffect(() => {
    if (open) {
      const seed = row ?? EMPTY_POLICY(packId);
      setDraft(seed);
      setExcludesText((seed.disposable_income_excludes ?? []).join(", "));
    }
  }, [open, row, packId]);

  const save = useMutation({
    mutationFn: async (input: PolicyRow) => {
      const excludes = excludesText.split(",").map((s) => s.trim()).filter(Boolean);
      const payload: any = {
        pack_id: packId,
        policy_key: input.policy_key || "default",
        aggregate_cap_pct: input.aggregate_cap_pct,
        min_take_home_amount: input.min_take_home_amount,
        min_take_home_pct: input.min_take_home_pct,
        disposable_income_excludes: excludes,
        priority_resolution: input.priority_resolution,
        protected_earnings_formula_token: input.protected_earnings_formula_token?.trim() || null,
        notes: input.notes?.trim() || null,
      };
      if (input.id) {
        const { error } = await (supabase as any)
          .from("localization_pack_garnishment_policies").update(payload).eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("localization_pack_garnishment_policies").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-garnishment-policy", packId, "default"] });
      setOpen(false);
      toast.success("Policy saved");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm">Aggregate policy</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Cross-order limits — applied once after all individual order amounts are calculated.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Pencil className="h-3.5 w-3.5 mr-1" /> {row ? "Edit" : "Configure"}
        </Button>
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && !row && (
          <div className="text-muted-foreground">
            No policy configured. The engine will fall back to per-order limits only — there will be no aggregate cap.
          </div>
        )}
        {row && (
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">Aggregate cap %</dt>
              <dd className="tabular-nums">{row.aggregate_cap_pct ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Min take-home (amt)</dt>
              <dd className="tabular-nums">{row.min_take_home_amount ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Min take-home (%)</dt>
              <dd className="tabular-nums">{row.min_take_home_pct ?? "—"}</dd>
            </div>
            <div className="col-span-2 md:col-span-3">
              <dt className="text-muted-foreground">Priority resolution</dt>
              <dd className="font-mono">{row.priority_resolution}</dd>
            </div>
            <div className="col-span-2 md:col-span-3">
              <dt className="text-muted-foreground">Protected earnings formula</dt>
              <dd className="font-mono">{row.protected_earnings_formula_token ?? "—"}</dd>
            </div>
          </dl>
        )}
      </CardContent>

      <LocalizationFormShell
        open={open}
        onOpenChange={setOpen}
        entity="garnishment-policy"
        mode={row ? "edit" : "create"}
        busy={save.isPending}
        onSubmit={() => draft && save.mutate(draft)}
      >
        {draft && (
          <>
            <WorkflowSheetSection number={1} title="Caps" subtitle="Leave a field blank to disable that limit. Percentages are 0–100.">
              <WorkflowSheetGrid columns={3}>
                <WorkflowField label="Aggregate cap %" hint="Max combined garnishment as % of disposable income.">
                  <NumericInput
                    min={0} max={100}
                    value={draft.aggregate_cap_pct}
                    onValueChange={(n) => setDraft({ ...draft, aggregate_cap_pct: n })}
                  />
                </WorkflowField>
                <WorkflowField label="Min take-home amount">
                  <NumericInput
                    min={0}
                    value={draft.min_take_home_amount}
                    onValueChange={(n) => setDraft({ ...draft, min_take_home_amount: n })}
                  />
                </WorkflowField>
                <WorkflowField label="Min take-home %">
                  <NumericInput
                    min={0} max={100}
                    value={draft.min_take_home_pct}
                    onValueChange={(n) => setDraft({ ...draft, min_take_home_pct: n })}
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={2} title="Resolution" subtitle="How the engine picks an order when multiple compete.">
              <WorkflowSheetGrid>
                <WorkflowField label="Priority resolution" required>
                  <Select
                    value={draft.priority_resolution}
                    onValueChange={(v) => setDraft({ ...draft, priority_resolution: v })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PRIORITY_RESOLUTIONS.map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </WorkflowField>
                <WorkflowField label="Protected earnings formula token" hint="Token path resolving to the formula at runtime.">
                  <Input
                    value={draft.protected_earnings_formula_token ?? ""}
                    onChange={(e) => setDraft({ ...draft, protected_earnings_formula_token: e.target.value })}
                    placeholder="system.protected_earnings.default"
                    className="font-mono"
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={3} title="Notes">
              <WorkflowField label="Disposable income excludes" hint="Comma-separated rule codes excluded when computing disposable income.">
                <Input
                  value={excludesText}
                  onChange={(e) => setExcludesText(e.target.value)}
                  placeholder="pension_employee, hosp_insurance"
                  className="font-mono"
                />
              </WorkflowField>
              <WorkflowField label="Internal notes" className="mt-3">
                <Textarea
                  value={draft.notes ?? ""}
                  rows={3}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  placeholder="Cite the regulation and effective date."
                />
              </WorkflowField>
            </WorkflowSheetSection>
          </>
        )}
      </LocalizationFormShell>
    </Card>
  );
}
