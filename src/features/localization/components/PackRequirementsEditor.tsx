/**
 * PackRequirementsEditor — CRUD over `pack_requirements`.
 *
 * A pack requirement describes something a tenant *must configure* before
 * onboarding or payroll can run under this pack — e.g. "employee needs a
 * KRA PIN", "org needs an NSSF employer number", "PAYE account mapped".
 * The `payroll_readiness_rules` engine and the onboarding checklist both
 * project these rows into blocking findings.
 *
 * Without this editor a publisher cannot declare a new blocker without
 * SQL. That makes onboarding checklists a developer feature and violates
 * the country-agnostic contract.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Trash2, ClipboardCheck } from "lucide-react";
import { toast } from "sonner";
import { LocalizationFormShell } from "./_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { normalizeError } from "@/services/resilience";
import { LocalizationEntityWorkspace } from "./_shared/LocalizationEntityWorkspace";
import type { SpreadsheetPreviewProps } from "./preview/SpreadsheetPreviewPane";

const SCOPES = [
  { value: "employee_field", label: "Employee field" },
  { value: "statutory_identifier", label: "Statutory identifier" },
  { value: "payroll_rule", label: "Payroll rule" },
  { value: "account_mapping", label: "Account mapping" },
  { value: "onboarding_item", label: "Onboarding item" },
] as const;

const MODULES = [
  { value: "core", label: "Core" },
  { value: "payroll", label: "Payroll" },
  { value: "attendance", label: "Attendance" },
  { value: "timesheets", label: "Timesheets" },
  { value: "benefits", label: "Benefits" },
  { value: "hr", label: "HR" },
] as const;

const DATA_TYPES = ["text", "number", "boolean", "uuid", "date", "json"] as const;

interface Row {
  id: string;
  pack_id: string | null;
  organization_id: string;
  business_id: string;
  scope: string;
  module: string;
  requirement_key: string;
  country_code: string | null;
  label: string;
  help_text: string | null;
  validation_regex: string | null;
  data_type: string;
  is_required: boolean;
  blocks_onboarding: boolean;
  blocks_payroll: boolean;
  sort_order: number;
  is_active: boolean;
}

const EMPTY = (pack_id: string): Row => ({
  id: "",
  pack_id,
  organization_id: "00000000-0000-0000-0000-000000000000",
  business_id: "00000000-0000-0000-0000-000000000000",
  scope: "employee_field",
  module: "payroll",
  requirement_key: "",
  country_code: null,
  label: "",
  help_text: null,
  validation_regex: null,
  data_type: "text",
  is_required: true,
  blocks_onboarding: false,
  blocks_payroll: true,
  sort_order: 0,
  is_active: true,
});

export function PackRequirementsEditor({ packId }: { packId: string }) {
  const qc = useQueryClient();

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["pack-requirements", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_requirements")
        .select("*")
        .eq("pack_id", packId)
        .eq("source", "pack")
        .order("module")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const [editing, setEditing] = useState<Row | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);

  const upsert = useMutation({
    mutationFn: async (row: Row) => {
      const payload: any = { ...row, source: "pack" };
      if (!payload.id) delete payload.id;
      const { error } = await (supabase as any)
        .from("pack_requirements")
        .upsert(payload, { onConflict: "id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Requirement saved");
      qc.invalidateQueries({ queryKey: ["pack-requirements", packId] });
      setEditing(null);
    },
    onError: (e) => toast.error(normalizeError(e).message ?? "Save failed"),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("pack_requirements")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Requirement removed");
      qc.invalidateQueries({ queryKey: ["pack-requirements", packId] });
      setConfirmDelete(null);
    },
    onError: (e) => toast.error(normalizeError(e).message ?? "Delete failed"),
  });

  const previewProps: SpreadsheetPreviewProps = {
    title: "Onboarding & payroll requirements",
    formatLabel: `${rows.length} requirement${rows.length === 1 ? "" : "s"}`,
    columns: [
      { header: "Key" },
      { header: "Label" },
      { header: "Scope" },
      { header: "Module" },
      { header: "Type" },
      { header: "Required" },
      { header: "Blocks onboarding" },
      { header: "Blocks payroll" },
      { header: "Status" },
    ],
    rows: rows.map((r) => [
      r.requirement_key,
      r.label,
      r.scope,
      r.module,
      r.data_type,
      r.is_required ? "yes" : "no",
      r.blocks_onboarding ? "yes" : "—",
      r.blocks_payroll ? "yes" : "—",
      r.is_active ? "active" : "inactive",
    ]),
    footnote: "Rows project into blocking findings for the readiness engine and onboarding checklist.",
  };

  const editorContent = (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4" /> Onboarding &amp; payroll requirements
        </CardTitle>
        <Button size="sm" onClick={() => setEditing(EMPTY(packId))}>
          <Plus className="h-4 w-4 mr-1" /> New requirement
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No requirements yet. Add the fields, identifiers, rules and mappings
            a tenant must configure before onboarding or payroll can proceed —
            these become blocking findings in the readiness engine.
          </p>
        ) : (
          <div className="divide-y">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{r.requirement_key}</span>
                    <Badge variant="secondary">{r.module}</Badge>
                    <Badge variant="outline">{r.scope}</Badge>
                    {r.blocks_onboarding && <Badge variant="destructive">Onboarding</Badge>}
                    {r.blocks_payroll && <Badge variant="destructive">Payroll</Badge>}
                    {!r.is_active && <Badge variant="secondary">Inactive</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">{r.label}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(r)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {editing && (
        <LocalizationFormShell
          open
          onOpenChange={(v) => !v && setEditing(null)}
          entity="pack-requirement"
          mode={editing.id ? "edit" : "create"}
          title={editing.id ? `Edit ${editing.requirement_key}` : undefined}
          busy={upsert.isPending}
          onSubmit={() => upsert.mutate(editing)}
        >
          <WorkflowSheetSection title="Identity">
            <WorkflowSheetGrid>
              <WorkflowField label="Requirement key" required>
                <Input
                  value={editing.requirement_key}
                  onChange={(e) => setEditing({ ...editing, requirement_key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                  placeholder="kra_pin"
                />
              </WorkflowField>
              <WorkflowField label="Label" required>
                <Input
                  value={editing.label}
                  onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                  placeholder="KRA PIN"
                />
              </WorkflowField>
              <WorkflowField label="Country code (optional)">
                <Input
                  value={editing.country_code ?? ""}
                  onChange={(e) => setEditing({ ...editing, country_code: e.target.value.toUpperCase() || null })}
                  maxLength={2}
                  placeholder="KE"
                />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>

          <WorkflowSheetSection title="Classification">
            <WorkflowSheetGrid>
              <WorkflowField label="Scope" required>
                <Select value={editing.scope} onValueChange={(v) => setEditing({ ...editing, scope: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SCOPES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </WorkflowField>
              <WorkflowField label="Module" required>
                <Select value={editing.module} onValueChange={(v) => setEditing({ ...editing, module: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MODULES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </WorkflowField>
              <WorkflowField label="Data type" required>
                <Select value={editing.data_type} onValueChange={(v) => setEditing({ ...editing, data_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DATA_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </WorkflowField>
              <WorkflowField label="Sort order">
                <Input
                  type="number"
                  value={editing.sort_order}
                  onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) || 0 })}
                />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>

          <WorkflowSheetSection title="Behaviour">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={editing.is_required} onCheckedChange={(v) => setEditing({ ...editing, is_required: !!v })} />
                Required
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={editing.is_active} onCheckedChange={(v) => setEditing({ ...editing, is_active: !!v })} />
                Active
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={editing.blocks_onboarding} onCheckedChange={(v) => setEditing({ ...editing, blocks_onboarding: !!v })} />
                Blocks onboarding
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={editing.blocks_payroll} onCheckedChange={(v) => setEditing({ ...editing, blocks_payroll: !!v })} />
                Blocks payroll
              </label>
            </div>
          </WorkflowSheetSection>

          <WorkflowSheetSection title="Guidance">
            <WorkflowField label="Help text">
              <Textarea
                rows={2}
                value={editing.help_text ?? ""}
                onChange={(e) => setEditing({ ...editing, help_text: e.target.value || null })}
                placeholder="Shown to the tenant when this requirement blocks a flow."
              />
            </WorkflowField>
            <WorkflowField label="Validation regex (optional)">
              <Input
                value={editing.validation_regex ?? ""}
                onChange={(e) => setEditing({ ...editing, validation_regex: e.target.value || null })}
                placeholder="^[A-Z][0-9]{9}[A-Z]$"
              />
            </WorkflowField>
          </WorkflowSheetSection>
        </LocalizationFormShell>
      )}

      {confirmDelete && (
        <LocalizationFormShell
          open
          onOpenChange={(v) => !v && setConfirmDelete(null)}
          entity="pack-requirement"
          mode="edit"
          title={`Delete ${confirmDelete.requirement_key}?`}
          description="Existing tenants with this requirement satisfied are not affected; new tenants will no longer be prompted."
          busy={remove.isPending}
          onSubmit={() => remove.mutate(confirmDelete.id)}
          submitLabel="Delete"
        >
          <p className="text-sm text-muted-foreground">
            This removes <span className="font-mono">{confirmDelete.requirement_key}</span> from the pack.
          </p>
        </LocalizationFormShell>
      )}
    </Card>
    </div>
  );

  return (
    <LocalizationEntityWorkspace
      workspaceId={`pack-requirements:${packId}`}
      kind="pack-requirements"
      templateCode={packId}
      displayName="Pack requirements"
      preview={{ pane: "spreadsheet", props: previewProps }}
      editor={editorContent}
      statusBar={
        <div className="flex items-center gap-4">
          <span>{rows.length} requirement{rows.length === 1 ? "" : "s"}</span>
          <span>{rows.filter((r) => r.blocks_payroll).length} block payroll</span>
          <span>{rows.filter((r) => r.blocks_onboarding).length} block onboarding</span>
          <span className="ml-auto hidden md:inline text-[10px] uppercase tracking-wide text-muted-foreground/70">
            ⌘B outline · ⌘⇧P preview · ⌘⇧F focus
          </span>
        </div>
      }
    />
  );
}
