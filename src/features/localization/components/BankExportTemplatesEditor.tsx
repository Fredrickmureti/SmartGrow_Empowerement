/**
 * BankExportTemplatesEditor — CRUD over `localization_pack_bank_export_templates`.
 *
 * Bank export templates describe how a payroll payment batch is serialised
 * for a specific bank (CSV column order, fixed-width layouts, or
 * vendor-specific specs like Equity's iBiz). Without UI authoring,
 * publishers cannot add a new bank without a SQL migration; with it,
 * onboarding a new bank for an entire country becomes a 60-second task.
 *
 * The `spec` JSONB shape varies per `builder_kind`; we expose it as a
 * structured JSON editor here. The platform-side serialiser
 * (`payroll-bank-export`) validates the spec against the builder kind at
 * runtime, so malformed specs surface as build-time errors on first use,
 * not silent payment failures.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Pencil, Trash2, Landmark, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { LocalizationFormShell } from "./_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { normalizeError } from "@/services/resilience";

const BUILDER_KINDS = [
  { value: "csv_columns", label: "CSV — columns" },
  { value: "fixed_width", label: "Fixed-width text" },
  { value: "iso20022_pain001", label: "ISO 20022 pain.001 (XML)" },
  { value: "vendor_specific", label: "Vendor-specific (custom serialiser)" },
] as const;

interface Row {
  id: string;
  pack_id: string | null;
  format_code: string;
  display_name: string;
  country_code: string | null;
  file_extension: string;
  mime_type: string;
  builder_kind: string;
  spec: any;
  is_active: boolean;
}

const EMPTY = (pack_id: string): Row => ({
  id: "",
  pack_id,
  format_code: "",
  display_name: "",
  country_code: null,
  file_extension: "csv",
  mime_type: "text/csv;charset=utf-8",
  builder_kind: "csv_columns",
  spec: { columns: [] },
  is_active: true,
});

const SAMPLE_SPECS: Record<string, any> = {
  csv_columns: {
    columns: [
      { header: "Account", token: "employee.bank_account_number" },
      { header: "Amount", token: "system.net_pay", format: "decimal:2" },
      { header: "Reference", token: "period.code" },
    ],
    include_header: true,
    delimiter: ",",
  },
  fixed_width: {
    line_length: 120,
    fields: [
      { start: 1, length: 16, token: "employee.bank_account_number", pad: "right" },
      { start: 17, length: 12, token: "system.net_pay", format: "decimal:2", pad: "left", filler: "0" },
    ],
  },
  iso20022_pain001: {
    initiating_party: "employer.legal_name",
    debtor_account: "employer.bank_account_number",
    payment_method: "TRF",
  },
  vendor_specific: { serializer: "equity_ibiz", version: "1.0" },
};

export function BankExportTemplatesEditor({ packId }: { packId: string | null }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["pack-bank-exports", packId],
    enabled: !!packId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("localization_pack_bank_export_templates")
        .select("*")
        .eq("pack_id", packId)
        .order("display_name");
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const [draft, setDraft] = useState<Row | null>(null);
  const [specText, setSpecText] = useState("");
  const [specError, setSpecError] = useState<string | null>(null);

  useEffect(() => {
    if (draft) {
      try {
        setSpecText(JSON.stringify(draft.spec ?? {}, null, 2));
        setSpecError(null);
      } catch {
        setSpecText("{}");
      }
    }
  }, [draft?.id]);

  const save = useMutation({
    mutationFn: async (input: Row) => {
      let spec: any;
      try {
        spec = specText.trim() ? JSON.parse(specText) : {};
      } catch (e: any) {
        throw new Error(`Spec is not valid JSON: ${e.message}`);
      }
      const payload: any = {
        pack_id: packId,
        format_code: input.format_code.trim(),
        display_name: input.display_name.trim(),
        country_code: input.country_code?.trim() || null,
        file_extension: input.file_extension.trim() || "csv",
        mime_type: input.mime_type.trim() || "text/csv;charset=utf-8",
        builder_kind: input.builder_kind,
        spec,
        is_active: input.is_active,
      };
      if (input.id) {
        const { error } = await (supabase as any)
          .from("localization_pack_bank_export_templates").update(payload).eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("localization_pack_bank_export_templates").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-bank-exports", packId] });
      setDraft(null);
      toast.success("Bank export template saved");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("localization_pack_bank_export_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-bank-exports", packId] });
      toast.success("Template deleted");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  if (!packId) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Select a pack to manage bank export templates.
        </CardContent>
      </Card>
    );
  }

  const validateSpec = (text: string) => {
    if (!text.trim()) { setSpecError(null); return; }
    try { JSON.parse(text); setSpecError(null); }
    catch (e: any) { setSpecError(e.message); }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm flex items-center gap-2">
            <Landmark className="h-4 w-4" /> Bank export templates
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Serialisers for payroll payment batches. Each row is one bank/format combination available to tenants in this country.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setDraft(EMPTY(packId))}>
          <Plus className="h-3.5 w-3.5 mr-1" /> New template
        </Button>
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && (data ?? []).length === 0 && (
          <div className="text-muted-foreground py-4">
            No bank export templates yet. Tenants on this pack will have no bank file format available — they'll have to download a generic CSV.
          </div>
        )}
        {(data ?? []).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3">Format</th>
                  <th className="py-1.5 pr-3">Bank / display</th>
                  <th className="py-1.5 pr-3">Builder</th>
                  <th className="py-1.5 pr-3">Ext</th>
                  <th className="py-1.5 pr-3">Country</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-mono">{r.format_code}</td>
                    <td className="py-1.5 pr-3">{r.display_name}</td>
                    <td className="py-1.5 pr-3 font-mono">{r.builder_kind}</td>
                    <td className="py-1.5 pr-3">.{r.file_extension}</td>
                    <td className="py-1.5 pr-3 font-mono">{r.country_code ?? "—"}</td>
                    <td className="py-1.5 pr-3">
                      {r.is_active
                        ? <Badge variant="outline" className="text-[10px]">active</Badge>
                        : <Badge variant="destructive" className="text-[10px]">inactive</Badge>}
                    </td>
                    <td className="py-1.5 text-right space-x-1">
                      <Button size="icon" variant="ghost" onClick={() => setDraft(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => { if (confirm(`Delete template "${r.format_code}"?`)) del.mutate(r.id); }}
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
        entity="bank-export"
        mode={draft?.id ? "edit" : "create"}
        busy={save.isPending}
        submitDisabled={!draft?.format_code?.trim() || !draft?.display_name?.trim() || !!specError}
        onSubmit={() => draft && save.mutate(draft)}
      >
        {draft && (
          <>
            <WorkflowSheetSection number={1} title="Identity" subtitle="Format code is stable; display name is shown to payroll officers.">
              <WorkflowSheetGrid>
                <WorkflowField label="Format code" required hint="Stable identifier, e.g. equity_kes_csv">
                  <Input
                    value={draft.format_code}
                    onChange={(e) => setDraft({ ...draft, format_code: e.target.value })}
                    placeholder="equity_kes_csv"
                    className="font-mono"
                  />
                </WorkflowField>
                <WorkflowField label="Display name" required>
                  <Input
                    value={draft.display_name}
                    onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                    placeholder="Equity Bank — Payroll CSV"
                  />
                </WorkflowField>
                <WorkflowField label="Country (ISO-2)" hint="Optional — leave blank for multi-country banks.">
                  <Input
                    value={draft.country_code ?? ""}
                    onChange={(e) => setDraft({ ...draft, country_code: e.target.value.toUpperCase() })}
                    placeholder="KE"
                    maxLength={2}
                    className="font-mono"
                  />
                </WorkflowField>
                <WorkflowField label="Active">
                  <label className="flex items-center gap-2 text-sm h-9">
                    <Checkbox
                      checked={draft.is_active}
                      onCheckedChange={(v) => setDraft({ ...draft, is_active: !!v })}
                    />
                    Available to tenants
                  </label>
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={2} title="File envelope" subtitle="Controls what the browser downloads.">
              <WorkflowSheetGrid columns={3}>
                <WorkflowField label="Builder kind" required>
                  <Select
                    value={draft.builder_kind}
                    onValueChange={(v) => {
                      const sample = SAMPLE_SPECS[v] ?? {};
                      setDraft({ ...draft, builder_kind: v, spec: sample });
                      setSpecText(JSON.stringify(sample, null, 2));
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {BUILDER_KINDS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </WorkflowField>
                <WorkflowField label="File extension" required>
                  <Input
                    value={draft.file_extension}
                    onChange={(e) => setDraft({ ...draft, file_extension: e.target.value })}
                    placeholder="csv"
                  />
                </WorkflowField>
                <WorkflowField label="MIME type" required>
                  <Input
                    value={draft.mime_type}
                    onChange={(e) => setDraft({ ...draft, mime_type: e.target.value })}
                    placeholder="text/csv;charset=utf-8"
                    className="font-mono text-xs"
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={3} title="Spec" subtitle="Shape depends on builder kind. The serialiser validates this at runtime.">
              <WorkflowField label="JSON spec" required>
                <Textarea
                  value={specText}
                  onChange={(e) => { setSpecText(e.target.value); validateSpec(e.target.value); }}
                  rows={14}
                  className="font-mono text-xs"
                />
              </WorkflowField>
              {specError && (
                <Alert variant="destructive" className="mt-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>Invalid JSON: {specError}</AlertDescription>
                </Alert>
              )}
            </WorkflowSheetSection>
          </>
        )}
      </LocalizationFormShell>
    </Card>
  );
}
