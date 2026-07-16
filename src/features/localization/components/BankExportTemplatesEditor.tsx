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
 *
 * ── Enterprise workspace shell ────────────────────────────────────────
 * The editor is mounted inside `AuthoringWorkspace` so publishers get the
 * same layout modes / keyboard shortcuts / pop-out preview they have on
 * the certificate & return editors. The preview slot is a live
 * `SpreadsheetPreviewPane` that renders the draft's `spec` against a
 * synthetic KE payroll fixture — so publishers see the exact CSV /
 * fixed-width file layout they are authoring, without having to save,
 * run a payroll, and download the file.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Plus, Pencil, Trash2, Landmark, AlertTriangle, CircleDot, CircleCheck, CircleAlert, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { normalizeError } from "@/services/resilience";
import { AuthoringWorkspace } from "@/design-system/primitives/AuthoringWorkspace";
import { SpreadsheetPreviewPane, type SpreadsheetPreviewProps, type SpreadsheetPreviewColumn } from "./preview/SpreadsheetPreviewPane";
import { openPreviewWindow, publishPreview } from "../lib/previewBroadcast";
import { KE_RETURN_PREVIEW_PAYLOAD } from "../lib/fixtures/keReturnFixture";

const BUILDER_KINDS = [
  { value: "csv_columns", label: "CSV — columns" },
  { value: "fixed_width", label: "Fixed-width text" },
  { value: "iso20022_pain001", label: "ISO 20022 pain.001 (XML)" },
  { value: "vendor_specific", label: "Vendor-specific (custom serialiser)" },
] as const;
const BUILDER_LABEL: Record<string, string> = Object.fromEntries(BUILDER_KINDS.map((b) => [b.value, b.label]));

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

// ── Token resolver against the shared KE payroll fixture ─────────────
// Bank-export tokens are simple dotted paths (`employee.bank_account_number`,
// `system.net_pay`, `period.code`). We reuse the same fixture that powers
// the return preview so publishers see consistent sample data across the
// whole workspace.
function resolveBankExportToken(token: string, rowIdx: number): string | number | null {
  const p = KE_RETURN_PREVIEW_PAYLOAD;
  const row = p.rows[rowIdx % p.rows.length];
  const [ns, key] = token.split(".");
  if (!ns || !key) return null;
  switch (ns) {
    case "employee": {
      if (key === "bank_account_number") return `0100${(1000 + rowIdx * 37).toString().padStart(10, "0")}`;
      if (key === "pin" || key === "tax_pin") return row.employee_pin;
      if (key === "name" || key === "full_name") return row.employee_name;
      return null;
    }
    case "system": {
      if (key === "net_pay") return row.employee_amount;
      if (key === "gross_pay") return Math.round(row.employee_amount * 1.4);
      return row.employee_amount;
    }
    case "employer": {
      if (key === "legal_name" || key === "name") return p.employer.name;
      if (key === "tax_pin") return p.employer.tax_pin;
      if (key === "bank_account_number") return "0100999999";
      return null;
    }
    case "period": {
      if (key === "code") return "2025-06";
      if (key === "label") return p.period_label;
      if (key === "start") return p.period_start;
      if (key === "end") return p.period_end;
      return null;
    }
    default:
      return null;
  }
}

/**
 * Derive the SpreadsheetPreviewPane props for the currently-drafted
 * bank export spec. Understands the three JSON-driven builder kinds; the
 * vendor-specific builder shows a summary card because the serialiser
 * is opaque to the UI.
 */
function buildBankExportPreview(input: {
  builder_kind: string;
  spec: any;
  file_extension: string;
  display_name: string;
  parseError: string | null;
}): SpreadsheetPreviewProps {
  const { builder_kind, spec, file_extension, display_name, parseError } = input;
  if (parseError) {
    return {
      title: display_name || "Bank export preview",
      formatLabel: BUILDER_LABEL[builder_kind] ?? builder_kind,
      columns: [],
      rows: [],
      error: `Spec is not valid JSON: ${parseError}`,
    };
  }

  if (builder_kind === "csv_columns") {
    const cols: Array<{ header?: string; token?: string; format?: string }> = Array.isArray(spec?.columns) ? spec.columns : [];
    const columns: SpreadsheetPreviewColumn[] = cols.map((c) => ({
      header: c.header ?? "",
      token: c.token ?? null,
      unresolved: !!c.token && resolveBankExportToken(c.token, 0) === null,
      numeric: /amount|net|pay|gross|tax/i.test(String(c.token ?? "")),
      format: c.format ?? null,
    }));
    const rows = KE_RETURN_PREVIEW_PAYLOAD.rows.map((_row, ri) =>
      cols.map((c) => (c.token ? resolveBankExportToken(c.token, ri) : "")),
    );
    const warnings: string[] = [];
    if (!cols.length) warnings.push("Spec has no `columns` array — the exported file will be empty.");
    if (spec?.include_header === false) warnings.push("Header row disabled — tenants importing the file will need to map columns manually.");
    return {
      title: display_name || "CSV export preview",
      formatLabel: BUILDER_LABEL.csv_columns,
      columns,
      rows,
      delimiter: typeof spec?.delimiter === "string" ? spec.delimiter : ",",
      encoding: "utf-8",
      fileExtension: file_extension || "csv",
      warnings,
      footnote: "Sample rows come from the shared KE payroll fixture.",
    };
  }

  if (builder_kind === "fixed_width") {
    const fields: Array<{ start?: number; length?: number; token?: string; format?: string; pad?: string; filler?: string }> = Array.isArray(spec?.fields) ? spec.fields : [];
    const columns: SpreadsheetPreviewColumn[] = fields.map((f) => ({
      header: `${f.start ?? "?"}–${(f.start ?? 0) + (f.length ?? 0) - 1}`,
      token: f.token ?? null,
      unresolved: !!f.token && resolveBankExportToken(f.token, 0) === null,
      numeric: /amount|net|pay/i.test(String(f.token ?? "")),
      width: f.length,
      format: f.format ?? f.pad ?? null,
    }));
    const rows = KE_RETURN_PREVIEW_PAYLOAD.rows.map((_row, ri) =>
      fields.map((f) => {
        if (!f.token) return "";
        const raw = resolveBankExportToken(f.token, ri);
        const s = raw === null ? "" : String(raw);
        const len = f.length ?? s.length;
        const filler = f.filler ?? " ";
        return f.pad === "left" ? s.padStart(len, filler).slice(0, len) : s.padEnd(len, filler).slice(0, len);
      }),
    );
    return {
      title: display_name || "Fixed-width export preview",
      formatLabel: BUILDER_LABEL.fixed_width,
      columns,
      rows,
      showRuler: true,
      encoding: "us-ascii",
      fileExtension: file_extension || "txt",
      footnote: `Line length: ${spec?.line_length ?? "—"} chars`,
    };
  }

  if (builder_kind === "iso20022_pain001") {
    return {
      title: display_name || "ISO 20022 pain.001 preview",
      formatLabel: BUILDER_LABEL.iso20022_pain001,
      columns: [
        { header: "XPath / mapping", numeric: false },
        { header: "Bound token" },
        { header: "Sample value", numeric: false },
      ],
      rows: Object.entries(spec ?? {}).map(([k, v]) => {
        const token = typeof v === "string" ? v : JSON.stringify(v);
        const sample = typeof v === "string" ? resolveBankExportToken(v, 0) : "—";
        return [k, token, sample ?? ""];
      }),
      fileExtension: file_extension || "xml",
      footnote: "ISO 20022 XML is generated server-side; this table shows the field bindings only.",
    };
  }

  return {
    title: display_name || "Vendor-specific export",
    formatLabel: BUILDER_LABEL.vendor_specific,
    columns: [
      { header: "Setting" },
      { header: "Value" },
    ],
    rows: Object.entries(spec ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    fileExtension: file_extension || "bin",
    warnings: ["Vendor-specific serialisers are opaque to the UI — verify with the vendor test harness before shipping."],
  };
}

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
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const initialSnapshotRef = useRef<string>("");

  useEffect(() => {
    if (draft) {
      try {
        setSpecText(JSON.stringify(draft.spec ?? {}, null, 2));
        setSpecError(null);
      } catch {
        setSpecText("{}");
      }
      // Fresh dirty-tracking snapshot each time we open a different draft.
      initialSnapshotRef.current = JSON.stringify({ d: draft, s: draft.spec ?? {} });
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
      setLastSavedAt(Date.now());
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

  // ── Live-derived preview payload ─────────────────────────────────
  const parsedSpec = useMemo(() => {
    if (!draft) return { spec: {}, err: null as string | null };
    if (!specText.trim()) return { spec: {}, err: null };
    try { return { spec: JSON.parse(specText), err: null }; }
    catch (e: any) { return { spec: null, err: e.message as string }; }
  }, [specText, draft]);

  const previewProps: SpreadsheetPreviewProps = useMemo(() => {
    if (!draft) {
      // No draft open → surface the configured templates as a summary grid so the
      // preview slot is never dead space.
      const list = data ?? [];
      return {
        title: "Configured bank export templates",
        formatLabel: `${list.length} template${list.length === 1 ? "" : "s"}`,
        columns: [
          { header: "Format" },
          { header: "Bank / display" },
          { header: "Builder" },
          { header: "Ext" },
          { header: "Country" },
          { header: "Status" },
        ],
        rows: list.map((r) => [r.format_code, r.display_name, r.builder_kind, `.${r.file_extension}`, r.country_code ?? "—", r.is_active ? "active" : "inactive"]),
        footnote: "Select or create a template to preview its exported file.",
      };
    }
    return buildBankExportPreview({
      builder_kind: draft.builder_kind,
      spec: parsedSpec.spec,
      file_extension: draft.file_extension,
      display_name: draft.display_name,
      parseError: parsedSpec.err,
    });
  }, [draft, data, parsedSpec]);

  // Broadcast to pop-out preview window.
  useEffect(() => {
    if (!draft) return;
    publishPreview({
      kind: "bank-export",
      templateCode: draft.format_code || `draft-${draft.id || "new"}`,
      body: previewProps as unknown,
      meta: null,
      displayName: draft.display_name,
      updatedAt: Date.now(),
    });
  }, [draft, previewProps]);

  const handlePopOutPreview = () => {
    if (!draft) return;
    openPreviewWindow("bank-export", draft.format_code || `draft-${draft.id || "new"}`);
  };

  const handleSave = () => {
    if (!draft) return;
    if (specError) return;
    if (!draft.format_code?.trim() || !draft.display_name?.trim()) return;
    save.mutate(draft);
  };

  // ── Slots ─────────────────────────────────────────────────────────
  const toolbar = (
    <>
      <Landmark className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-semibold">Bank export templates</span>
      {draft && (
        <>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
            {draft.format_code || "new"}
          </code>
          <Badge variant="outline" className="text-[10px]">
            {draft.id ? "Edit" : "New"}
          </Badge>
        </>
      )}
      <div className="mx-1 h-4 w-px bg-border" />
      <Button size="sm" variant="outline" onClick={() => setDraft(EMPTY(packId!))}>
        <Plus className="h-3.5 w-3.5 mr-1" /> New template
      </Button>
    </>
  );

  const rail = (
    <ScrollArea className="h-full">
      <div className="border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Templates · {(data ?? []).length}
      </div>
      {isLoading && <div className="p-3 text-xs text-muted-foreground">Loading…</div>}
      {!isLoading && (data ?? []).length === 0 && (
        <div className="p-3 text-xs text-muted-foreground">
          None yet. Create one to see its preview.
        </div>
      )}
      <div className="p-1 text-sm">
        {(data ?? []).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setDraft(r)}
            className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted ${draft?.id === r.id ? "bg-muted" : ""}`}
          >
            <span className="text-xs font-medium">{r.display_name}</span>
            <span className="flex w-full items-center justify-between text-[10px] text-muted-foreground">
              <span className="font-mono">{r.format_code}</span>
              <span>{r.is_active ? "active" : "inactive"}</span>
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );

  const editorBody = draft ? (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        <section className="rounded border bg-card">
          <header className="border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Identity
          </header>
          <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Format code *</span>
              <Input
                value={draft.format_code}
                onChange={(e) => setDraft({ ...draft, format_code: e.target.value })}
                placeholder="equity_kes_csv"
                className="font-mono"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Display name *</span>
              <Input
                value={draft.display_name}
                onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                placeholder="Equity Bank — Payroll CSV"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Country (ISO-2)</span>
              <Input
                value={draft.country_code ?? ""}
                onChange={(e) => setDraft({ ...draft, country_code: e.target.value.toUpperCase() })}
                placeholder="KE"
                maxLength={2}
                className="font-mono"
              />
            </label>
            <label className="flex items-center gap-2 pt-5 text-xs">
              <Checkbox
                checked={draft.is_active}
                onCheckedChange={(v) => setDraft({ ...draft, is_active: !!v })}
              />
              Available to tenants
            </label>
          </div>
        </section>

        <section className="rounded border bg-card">
          <header className="border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            File envelope
          </header>
          <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-3">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Builder kind *</span>
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
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">File extension *</span>
              <Input
                value={draft.file_extension}
                onChange={(e) => setDraft({ ...draft, file_extension: e.target.value })}
                placeholder="csv"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">MIME type *</span>
              <Input
                value={draft.mime_type}
                onChange={(e) => setDraft({ ...draft, mime_type: e.target.value })}
                placeholder="text/csv;charset=utf-8"
                className="font-mono text-xs"
              />
            </label>
          </div>
        </section>

        <section className="rounded border bg-card">
          <header className="flex items-center justify-between border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Spec (JSON)</span>
            <span className="normal-case tracking-normal text-[10px] text-muted-foreground/70">
              Shape depends on builder kind · validated by the serialiser
            </span>
          </header>
          <div className="p-3">
            <Textarea
              value={specText}
              onChange={(e) => { setSpecText(e.target.value); validateSpec(e.target.value); }}
              rows={14}
              className="font-mono text-xs"
            />
            {specError && (
              <Alert variant="destructive" className="mt-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>Invalid JSON: {specError}</AlertDescription>
              </Alert>
            )}
          </div>
        </section>

        {draft.id && (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => { if (confirm(`Delete template "${draft.format_code}"?`)) { del.mutate(draft.id); setDraft(null); } }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete template
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <Landmark className="h-6 w-6 opacity-40" />
      <p>Select a template on the left, or create a new one, to start authoring.</p>
      <p className="max-w-md text-xs">
        Each row here becomes one bank/format combination available to tenants in this country.
      </p>
      <Button size="sm" variant="outline" className="mt-2" onClick={() => setDraft(EMPTY(packId!))}>
        <Plus className="h-3.5 w-3.5 mr-1" /> New template
      </Button>
    </div>
  );

  const footerBar = draft ? (
    <div className="flex items-center justify-end gap-2">
      <Button variant="ghost" onClick={() => setDraft(null)} disabled={save.isPending}>
        <X className="h-3.5 w-3.5 mr-1" /> Close
      </Button>
      <Button
        onClick={handleSave}
        disabled={save.isPending || !!specError || !draft.format_code?.trim() || !draft.display_name?.trim()}
      >
        {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
        Save template
      </Button>
    </div>
  ) : undefined;

  const isDirty = draft
    ? JSON.stringify({ d: draft, s: parsedSpec.spec ?? {} }) !== initialSnapshotRef.current
    : false;
  const unresolved = previewProps.columns.filter((c) => c.unresolved).length;
  const issueCount = (specError ? 1 : 0) + unresolved;
  const statusBar = (
    <div className="flex items-center gap-4">
      <span className="flex items-center gap-1.5">
        {isDirty ? (
          <><CircleDot className="h-3 w-3 text-amber-500" /> Unsaved changes</>
        ) : (
          <><CircleCheck className="h-3 w-3 text-emerald-500" />
            {lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}` : "All changes saved"}
          </>
        )}
      </span>
      <span className="flex items-center gap-1.5">
        {issueCount > 0 ? (
          <><CircleAlert className="h-3 w-3 text-destructive" /> {issueCount} issue{issueCount === 1 ? "" : "s"}</>
        ) : (
          <><CircleCheck className="h-3 w-3 text-emerald-500" /> No issues</>
        )}
      </span>
      <span className="ml-auto hidden text-[10px] uppercase tracking-wide text-muted-foreground/70 md:inline">
        ⌘S save · ⌘B outline · ⌘⇧P preview · ⌘⇧F focus
      </span>
    </div>
  );

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[600px] flex-col bg-background">
      <AuthoringWorkspace
        workspaceId={`bank-export:${packId}:${draft?.format_code || "list"}`}
        toolbar={toolbar}
        rail={rail}
        editor={editorBody}
        preview={<SpreadsheetPreviewPane {...previewProps} />}
        footer={footerBar}
        statusBar={statusBar}
        defaultMode="overlay"
        onSave={handleSave}
        onPopOutPreview={handlePopOutPreview}
      />
    </div>
  );
}
