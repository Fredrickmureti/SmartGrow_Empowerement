import { normalizeError } from "@/services/resilience";
/**
 * ReturnTemplateEditor — structured editor for the columnar
 * `localization_pack_return_templates.body` shape consumed by
 * `generate-statutory-return`. Pure form-driven: no JSON ever shown to
 * the human. Same `mode + onSave + onCancel` contract as `TemplateEditor`
 * so callers (PackEntityTabs, tenant Templates page) can dispatch on the
 * source table.
 *
 * Body shape (frozen by `_shared/returnTemplateSchema.ts`):
 *   {
 *     filters: { rule_codes: string[], payslip_status?: string[] },
 *     columns: [{ key, source, label?, format? }],
 *     group_by: string[],
 *     totals: string[],
 *     reconciliation?: { rule_code: string }
 *   }
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, AlertTriangle, FileText, Plus, Trash2, ArrowUp, ArrowDown, X, ShieldCheck, Building2 } from "lucide-react";
import { toast } from "sonner";
import { validatePayload } from "../hooks";
import { usePackTokens, type PackTokenOption } from "../hooks/usePackTokens";
import { useStatutoryAuthorities } from "../hooks/useStatutoryAuthorities";
import { PreviewPanel } from "./PreviewPanel";
import type { EditorMode } from "../types";

// First-class metadata (Slice A columns on
// localization_pack_return_templates). Edited via the metadata section
// below; persisted by callers through the extended onSave contract.
export type SubmissionFormatKind = "csv" | "xlsx" | "xml" | "json" | "pdf";
export type SubmissionFormatSpec = { kind?: SubmissionFormatKind; options?: Record<string, any> };
export type ReturnTemplateMetadata = {
  authority_id: string | null;
  legal_reference: string | null;
  regulation_citation: string | null;
  effective_date: string | null;
  sunset_date: string | null;
  submission_channel: string | null;
  submission_format: SubmissionFormatSpec | null;
  digital_signature_spec: Record<string, any> | null;
  acknowledgement_spec: Record<string, any> | null;
  api_endpoint_spec: Record<string, any> | null;
  approval_required: boolean;
};

function defaultMetadata(): ReturnTemplateMetadata {
  return {
    authority_id: null,
    legal_reference: null,
    regulation_citation: null,
    effective_date: null,
    sunset_date: null,
    submission_channel: null,
    submission_format: null,
    digital_signature_spec: null,
    acknowledgement_spec: null,
    api_endpoint_spec: null,
    approval_required: false,
  };
}

function normalizeMetadata(input: Partial<ReturnTemplateMetadata> | null | undefined): ReturnTemplateMetadata {
  const d = defaultMetadata();
  if (!input) return d;
  return {
    authority_id: input.authority_id ?? null,
    legal_reference: input.legal_reference ?? null,
    regulation_citation: input.regulation_citation ?? null,
    effective_date: input.effective_date ?? null,
    sunset_date: input.sunset_date ?? null,
    submission_channel: input.submission_channel ?? null,
    submission_format: (input.submission_format && typeof input.submission_format === "object")
      ? input.submission_format as SubmissionFormatSpec
      : null,
    digital_signature_spec: (input.digital_signature_spec && typeof input.digital_signature_spec === "object")
      ? input.digital_signature_spec as Record<string, any>
      : null,
    acknowledgement_spec: (input.acknowledgement_spec && typeof input.acknowledgement_spec === "object")
      ? input.acknowledgement_spec as Record<string, any>
      : null,
    api_endpoint_spec: (input.api_endpoint_spec && typeof input.api_endpoint_spec === "object")
      ? input.api_endpoint_spec as Record<string, any>
      : null,
    approval_required: !!input.approval_required,
  };
}

type Column = { key: string; source: string; label?: string; format?: string; width?: number };
type ReturnBody = {
  filters: { rule_codes: string[]; payslip_status?: string[] };
  columns: Column[];
  group_by?: string[];
  totals?: string[];
  reconciliation?: { rule_code?: string } | null;
};

// Pack-agnostic fallback tokens shown while the registry is loading or
// when the editor is opened without a pack context. These mirror the
// platform-reserved rows seeded into pack_token_registry (pack_id IS NULL)
// so the UI is deterministic even before the network call resolves.
// Country-specific identifiers are intentionally absent — they come from
// the registry, keyed by pack_id.
const RESERVED_PLATFORM_TOKENS: PackTokenOption[] = [
  { value: "employee.full_name",       label: "Employee — full_name",       numeric: false, source: "employee" },
  { value: "employee.employee_number", label: "Employee — employee_number", numeric: false, source: "employee" },
  { value: "sum_employee_amount",      label: "Aggregate — sum_employee_amount", numeric: true, source: "system" },
  { value: "sum_employer_amount",      label: "Aggregate — sum_employer_amount", numeric: true, source: "system" },
  { value: "sum_taxable_amount",       label: "Aggregate — sum_taxable_amount",  numeric: true, source: "system" },
];

const PAYSLIP_STATUSES = ["draft", "validated", "paid", "posted"] as const;
const FORMATS = ["text", "number", "currency", "date"] as const;

function defaultBody(): ReturnBody {
  return {
    filters: { rule_codes: [] },
    columns: [
      { key: "employee_pin", source: "employee.tax_pin", label: "PIN", format: "text" },
      { key: "employee_name", source: "employee.full_name", label: "Employee", format: "text" },
      { key: "employee_amount", source: "sum_employee_amount", label: "Employee", format: "currency" },
      { key: "employer_amount", source: "sum_employer_amount", label: "Employer", format: "currency" },
    ],
    group_by: ["employee_id"],
    totals: ["employee_amount", "employer_amount"],
  };
}

function normalizeBody(input: any): ReturnBody {
  const b = (input && typeof input === "object" && !Array.isArray(input)) ? input : {};
  return {
    filters: {
      rule_codes: Array.isArray(b?.filters?.rule_codes) ? b.filters.rule_codes : [],
      payslip_status: Array.isArray(b?.filters?.payslip_status) ? b.filters.payslip_status : undefined,
    },
    columns: Array.isArray(b?.columns) ? b.columns.map((c: any) => ({
      key: String(c?.key ?? ""),
      source: String(c?.source ?? ""),
      label: c?.label ?? undefined,
      format: c?.format ?? undefined,
      width: typeof c?.width === "number" ? c.width : undefined,
    })) : [],
    group_by: Array.isArray(b?.group_by) ? b.group_by : ["employee_id"],
    totals: Array.isArray(b?.totals) ? b.totals : [],
    reconciliation: b?.reconciliation && typeof b.reconciliation === "object"
      ? { rule_code: b.reconciliation.rule_code ?? "" }
      : null,
  };
}

function denormalizeBody(b: ReturnBody): any {
  const out: any = {
    filters: { rule_codes: b.filters.rule_codes },
    columns: b.columns.map((c) => {
      const o: any = { key: c.key, source: c.source };
      if (c.label) o.label = c.label;
      if (c.format) o.format = c.format;
      if (typeof c.width === "number") o.width = c.width;
      return o;
    }),
    group_by: b.group_by ?? ["employee_id"],
  };
  if (b.filters.payslip_status?.length) out.filters.payslip_status = b.filters.payslip_status;
  if (b.totals?.length) out.totals = b.totals;
  if (b.reconciliation?.rule_code) out.reconciliation = { rule_code: b.reconciliation.rule_code };
  return out;
}

interface Props {
  mode: EditorMode;
  packId?: string | null;
  templateCode: string;
  initial: {
    template_code: string;
    body: any;
    layout?: string | null;
    notes?: string | null;
    /** Slice-A first-class metadata. Optional for backwards compat with tenant callers. */
    metadata?: Partial<ReturnTemplateMetadata> | null;
  };
  /** Optional list of rule codes to suggest in the rule_codes picker. */
  ruleCodeSuggestions?: string[];
  onSave: (next: {
    body: any;
    layout: string | null;
    notes: string | null;
    /** Only emitted when admin mode + the caller opted into metadata editing. */
    metadata?: ReturnTemplateMetadata;
  }) => Promise<void> | void;
  onCancel?: () => void;
}

export function ReturnTemplateEditor({
  mode, packId, templateCode, initial, ruleCodeSuggestions = [], onSave, onCancel,
}: Props) {
  const [body, setBody] = useState<ReturnBody>(() => {
    const n = normalizeBody(initial.body);
    return n.columns.length ? n : defaultBody();
  });
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [newRuleCode, setNewRuleCode] = useState("");
  // Metadata is edited only in admin mode and only when the caller
  // passed an `initial.metadata` (signalling it can persist it).
  const editMetadata = mode === "admin" && initial.metadata !== undefined;
  const [meta, setMeta] = useState<ReturnTemplateMetadata>(() => normalizeMetadata(initial.metadata));
  const authoritiesQuery = useStatutoryAuthorities(editMetadata ? packId : null);


  // Token registry → drives the column-source picker. Replaces the
  // previous hardcoded KNOWN_SOURCES const. Country tokens (Kenya
  // identifiers today, Ghana SSNIT tomorrow) come from pack_token_registry
  // keyed by packId — no frontend change is needed to onboard new
  // countries.
  const tokensQuery = usePackTokens(packId);
  const sourceOptions: PackTokenOption[] = useMemo(() => {
    const fromRegistry = tokensQuery.data ?? [];
    if (fromRegistry.length > 0) return fromRegistry;
    return RESERVED_PLATFORM_TOKENS;
  }, [tokensQuery.data]);
  const numericByValue = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const o of sourceOptions) m.set(o.value, o.numeric);
    return m;
  }, [sourceOptions]);

  // Live validation
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await validatePayload({ kind: "return_template", body: denormalizeBody(body) });
        if (!cancelled) { setErrors(r.errors); setWarnings(r.warnings); }
      } catch { /* ignore */ }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [JSON.stringify(body)]);

  const addRuleCode = (code: string) => {
    const c = code.trim();
    if (!c) return;
    if (body.filters.rule_codes.includes(c)) return;
    setBody({ ...body, filters: { ...body.filters, rule_codes: [...body.filters.rule_codes, c] } });
    setNewRuleCode("");
  };
  const removeRuleCode = (code: string) => {
    setBody({ ...body, filters: { ...body.filters, rule_codes: body.filters.rule_codes.filter((c) => c !== code) } });
  };
  const togglePayslipStatus = (s: string, on: boolean) => {
    const cur = new Set(body.filters.payslip_status ?? []);
    on ? cur.add(s) : cur.delete(s);
    const next = Array.from(cur);
    setBody({ ...body, filters: { ...body.filters, payslip_status: next.length ? next : undefined } });
  };

  const updateColumn = (idx: number, patch: Partial<Column>) => {
    setBody({ ...body, columns: body.columns.map((c, i) => i === idx ? { ...c, ...patch } : c) });
  };
  const addColumn = () => {
    setBody({ ...body, columns: [...body.columns, { key: `col_${body.columns.length + 1}`, source: "employee.full_name", format: "text" }] });
  };
  const removeColumn = (idx: number) => {
    const removed = body.columns[idx];
    setBody({
      ...body,
      columns: body.columns.filter((_, i) => i !== idx),
      totals: body.totals?.filter((t) => t !== removed.key),
    });
  };
  const moveColumn = (idx: number, dir: -1 | 1) => {
    const next = [...body.columns];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setBody({ ...body, columns: next });
  };

  const toggleGroupBy = (v: string, on: boolean) => {
    const cur = new Set(body.group_by ?? []);
    on ? cur.add(v) : cur.delete(v);
    const next = Array.from(cur);
    setBody({ ...body, group_by: next.length ? next : ["employee_id"] });
  };

  const toggleTotal = (key: string, on: boolean) => {
    const cur = new Set(body.totals ?? []);
    on ? cur.add(key) : cur.delete(key);
    setBody({ ...body, totals: Array.from(cur) });
  };

  const numericColumnKeys = useMemo(
    () => body.columns.filter((c) => numericByValue.get(c.source) === true).map((c) => c.key),
    [body.columns, numericByValue],
  );

  const handleSave = async () => {
    setBusy(true);
    try {
      const payload = denormalizeBody(body);
      const r = await validatePayload({ kind: "return_template", body: payload });
      if (!r.valid) { setErrors(r.errors); setWarnings(r.warnings); toast.error("Fix errors before saving"); return; }
      if (mode === "tenant" && (notes ?? "").trim().length < 10) {
        toast.error("Reason (notes) must be at least 10 characters — used for the audit log.");
        return;
      }
      await onSave({
        body: payload,
        layout: null,
        notes: notes || null,
        ...(editMetadata ? { metadata: meta } : {}),
      });
      toast.success("Return template saved");
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {mode === "admin" ? "Statutory return template" : "Statutory return override"} —{" "}
          <code className="text-xs">{templateCode}</code>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">

        {editMetadata && (
          <MetadataSection
            meta={meta}
            onChange={setMeta}
            authorities={authoritiesQuery.data ?? []}
            authoritiesLoading={authoritiesQuery.isLoading}
          />
        )}

        {/* ── Filters ───────────────────────────────────────────── */}
        <section className="space-y-2">

          <h3 className="text-sm font-semibold">Rule codes <span className="text-destructive">*</span></h3>
          <p className="text-xs text-muted-foreground">
            Statutory rule codes whose payslip lines feed this return (e.g. <code>PAYE</code>,
            <code>NSSF</code>, <code>SHIF</code>).
          </p>
          <div className="flex flex-wrap gap-1.5">
            {body.filters.rule_codes.map((c) => (
              <Badge key={c} variant="secondary" className="gap-1">
                {c}
                <button type="button" onClick={() => removeRuleCode(c)} className="hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {body.filters.rule_codes.length === 0 && (
              <span className="text-xs text-muted-foreground">None — add at least one.</span>
            )}
          </div>
          <div className="flex gap-2">
            {ruleCodeSuggestions.length > 0 ? (
              <Select value="" onValueChange={(v) => addRuleCode(v)}>
                <SelectTrigger className="max-w-xs"><SelectValue placeholder="Pick a rule code…" /></SelectTrigger>
                <SelectContent>
                  {ruleCodeSuggestions.filter((s) => !body.filters.rule_codes.includes(s)).map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Input
              value={newRuleCode}
              onChange={(e) => setNewRuleCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRuleCode(newRuleCode); } }}
              placeholder="Add rule code (e.g. PAYE)"
              className="max-w-xs"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => addRuleCode(newRuleCode)}>
              <Plus className="h-3 w-3 mr-1" />Add
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Payslip statuses</h3>
          <p className="text-xs text-muted-foreground">
            Which payslip statuses are eligible. Default: validated and paid.
          </p>
          <div className="flex flex-wrap gap-3">
            {PAYSLIP_STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={(body.filters.payslip_status ?? []).includes(s)}
                  onCheckedChange={(v) => togglePayslipStatus(s, !!v)}
                />
                {s}
              </label>
            ))}
          </div>
        </section>

        {/* ── Columns ───────────────────────────────────────────── */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Columns <span className="text-destructive">*</span></h3>
            <Button type="button" variant="outline" size="sm" onClick={addColumn}>
              <Plus className="h-3 w-3 mr-1" />Add column
            </Button>
          </div>
          <div className="space-y-2">
            {body.columns.map((c, idx) => (
              <Card key={idx} className="p-3">
                <div className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3">
                    <Label className="text-xs">Key</Label>
                    <Input value={c.key} onChange={(e) => updateColumn(idx, { key: e.target.value })} />
                  </div>
                  <div className="col-span-3">
                    <Label className="text-xs">Header label</Label>
                    <Input value={c.label ?? ""} onChange={(e) => updateColumn(idx, { label: e.target.value })} />
                  </div>
                  <div className="col-span-3">
                    <Label className="text-xs">Source</Label>
                    <Select value={c.source} onValueChange={(v) => updateColumn(idx, { source: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {sourceOptions.map((s) => (
                          <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Format</Label>
                    <Select value={c.format ?? "text"} onValueChange={(v) => updateColumn(idx, { format: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {FORMATS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-1 flex gap-1 justify-end">
                    <Button type="button" size="icon" variant="ghost" onClick={() => moveColumn(idx, -1)} disabled={idx === 0}>
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" onClick={() => moveColumn(idx, 1)} disabled={idx === body.columns.length - 1}>
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" onClick={() => removeColumn(idx)}>
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
            {body.columns.length === 0 && (
              <p className="text-xs text-muted-foreground">No columns yet — click <em>Add column</em>.</p>
            )}
          </div>
        </section>

        {/* ── Group by ──────────────────────────────────────────── */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Group by</h3>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={(body.group_by ?? []).includes("employee_id")}
                onCheckedChange={(v) => toggleGroupBy("employee_id", !!v)}
              />
              One row per employee
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={(body.group_by ?? []).includes("aggregate")}
                onCheckedChange={(v) => toggleGroupBy("aggregate", !!v)}
              />
              Single aggregate row
            </label>
          </div>
        </section>

        {/* ── Totals ────────────────────────────────────────────── */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Totals row</h3>
          <p className="text-xs text-muted-foreground">
            Numeric columns to sum at the bottom of the return. Only numeric-source columns
            produce meaningful totals.
          </p>
          <div className="flex flex-wrap gap-3">
            {body.columns.length === 0 && <span className="text-xs text-muted-foreground">Add columns first.</span>}
            {body.columns.map((c) => {
              const isNumeric = numericColumnKeys.includes(c.key);
              return (
                <label key={c.key} className={`flex items-center gap-2 text-sm ${isNumeric ? "" : "text-muted-foreground"}`}>
                  <Checkbox
                    checked={(body.totals ?? []).includes(c.key)}
                    onCheckedChange={(v) => toggleTotal(c.key, !!v)}
                  />
                  <code className="text-xs">{c.key}</code>
                  {!isNumeric && <span className="text-xs">(non-numeric)</span>}
                </label>
              );
            })}
          </div>
        </section>

        {/* ── Reconciliation ────────────────────────────────────── */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Reconciliation (optional)</h3>
          <p className="text-xs text-muted-foreground">
            Compare the projected total against an existing payroll-liability total for a single
            rule code. Leave blank to skip.
          </p>
          <Input
            value={body.reconciliation?.rule_code ?? ""}
            onChange={(e) => setBody({ ...body, reconciliation: e.target.value ? { rule_code: e.target.value } : null })}
            placeholder="Rule code (e.g. PAYE)"
            className="max-w-xs"
          />
        </section>

        <PreviewPanel body={denormalizeBody(body)} packId={packId ?? null} title="Statutory return preview" />


        {/* ── Tenant override audit reason ──────────────────────── */}
        {mode === "tenant" && (
          <section className="space-y-1">
            <Label className="text-xs">Reason for override <span className="text-destructive">*</span> (≥10 chars)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Add new branch column for 2026 SHIF return" />
          </section>
        )}

        {warnings.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Warnings</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4 text-xs space-y-1">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </AlertDescription>
          </Alert>
        )}
        {errors.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Fix before saving</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4 text-xs space-y-1">{errors.map((e, i) => <li key={i} className="font-mono">{e}</li>)}</ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button onClick={handleSave} disabled={busy || errors.length > 0}>
            {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save return template
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Metadata section ──────────────────────────────────────────────
// Surfaces the first-class columns on
// `localization_pack_return_templates` so publishers don't hand-edit
// JSONB. Country-agnostic: every option is metadata-driven (authority
// FK, free-text channel, structured JSON specs).

const SUBMISSION_FORMAT_KINDS: { value: SubmissionFormatKind; label: string }[] = [
  { value: "csv",  label: "CSV"  },
  { value: "xlsx", label: "XLSX" },
  { value: "xml",  label: "XML"  },
  { value: "json", label: "JSON" },
  { value: "pdf",  label: "PDF"  },
];

function MetadataSection({
  meta,
  onChange,
  authorities,
  authoritiesLoading,
}: {
  meta: ReturnTemplateMetadata;
  onChange: (next: ReturnTemplateMetadata) => void;
  authorities: { id: string; code: string; display_name: string; country_code: string }[];
  authoritiesLoading: boolean;
}) {
  const patch = (p: Partial<ReturnTemplateMetadata>) => onChange({ ...meta, ...p });
  const fmt = meta.submission_format ?? {};
  const setFmt = (p: Partial<SubmissionFormatSpec>) =>
    patch({ submission_format: { ...fmt, ...p } });

  const jsonText = (v: Record<string, any> | null): string =>
    v == null ? "" : JSON.stringify(v, null, 2);
  const onJsonChange = (field: keyof ReturnTemplateMetadata, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) { patch({ [field]: null } as any); return; }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        patch({ [field]: parsed } as any);
      }
    } catch { /* leave previous value until JSON parses */ }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          Identification &amp; submission
        </h3>
        {meta.approval_required && (
          <Badge variant="secondary" className="gap-1">
            <ShieldCheck className="h-3 w-3" />
            Approval required
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-6">
          <Label className="text-xs">Authority <span className="text-destructive">*</span></Label>
          <Select
            value={meta.authority_id ?? ""}
            onValueChange={(v) => patch({ authority_id: v || null })}
          >
            <SelectTrigger>
              <SelectValue placeholder={authoritiesLoading ? "Loading…" : "Pick an authority…"} />
            </SelectTrigger>
            <SelectContent>
              {authorities.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.country_code} — {a.code} ({a.display_name})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-6">
          <Label className="text-xs">Submission channel</Label>
          <Input
            value={meta.submission_channel ?? ""}
            onChange={(e) => patch({ submission_channel: e.target.value || null })}
            placeholder="e.g. portal_upload, api, paper"
          />
        </div>

        <div className="col-span-6">
          <Label className="text-xs">Legal reference</Label>
          <Input
            value={meta.legal_reference ?? ""}
            onChange={(e) => patch({ legal_reference: e.target.value || null })}
            placeholder="e.g. Income Tax Act §37"
          />
        </div>
        <div className="col-span-6">
          <Label className="text-xs">Regulation citation</Label>
          <Input
            value={meta.regulation_citation ?? ""}
            onChange={(e) => patch({ regulation_citation: e.target.value || null })}
            placeholder="e.g. LN 248/2023"
          />
        </div>

        <div className="col-span-4">
          <Label className="text-xs">Effective date</Label>
          <Input
            type="date"
            value={meta.effective_date ?? ""}
            onChange={(e) => patch({ effective_date: e.target.value || null })}
          />
        </div>
        <div className="col-span-4">
          <Label className="text-xs">Sunset date</Label>
          <Input
            type="date"
            value={meta.sunset_date ?? ""}
            onChange={(e) => patch({ sunset_date: e.target.value || null })}
          />
        </div>
        <div className="col-span-4 flex flex-col gap-1">
          <Label className="text-xs">Approval required (SoD)</Label>
          <div className="flex items-center gap-2 h-9">
            <Switch
              checked={meta.approval_required}
              onCheckedChange={(v) => patch({ approval_required: !!v })}
            />
            <span className="text-xs text-muted-foreground">
              Preparer ≠ approver enforced at filing.
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase text-muted-foreground">Output format</h4>
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-4">
            <Label className="text-xs">Kind</Label>
            <Select
              value={fmt.kind ?? ""}
              onValueChange={(v) => setFmt({ kind: (v || undefined) as SubmissionFormatKind | undefined })}
            >
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                {SUBMISSION_FORMAT_KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-8">
            <Label className="text-xs">Options (JSON)</Label>
            <Textarea
              rows={3}
              className="font-mono text-xs"
              value={fmt.options ? JSON.stringify(fmt.options, null, 2) : ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (!raw) { setFmt({ options: undefined }); return; }
                try {
                  const parsed = JSON.parse(raw);
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    setFmt({ options: parsed });
                  }
                } catch { /* keep previous */ }
              }}
              placeholder='e.g. { "delimiter": ",", "encoding": "utf-8", "header": true }'
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <Label className="text-xs">Digital signature spec (JSON)</Label>
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={jsonText(meta.digital_signature_spec)}
            onChange={(e) => onJsonChange("digital_signature_spec", e.target.value)}
            placeholder='{ "method": "xmldsig", "cert_authority": "…", "hash_alg": "SHA-256" }'
          />
        </div>
        <div>
          <Label className="text-xs">Acknowledgement spec (JSON)</Label>
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={jsonText(meta.acknowledgement_spec)}
            onChange={(e) => onJsonChange("acknowledgement_spec", e.target.value)}
            placeholder='{ "mode": "async", "envelope_schema": "…" }'
          />
        </div>
        <div>
          <Label className="text-xs">API endpoint spec (JSON)</Label>
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={jsonText(meta.api_endpoint_spec)}
            onChange={(e) => onJsonChange("api_endpoint_spec", e.target.value)}
            placeholder='{ "url_template": "https://…", "auth_scheme": "oauth2", "payload_schema_ref": "…" }'
          />
        </div>
      </div>
    </section>
  );
}

// Exposed for tests
export const __test = { normalizeBody, denormalizeBody, defaultBody, normalizeMetadata, defaultMetadata };

