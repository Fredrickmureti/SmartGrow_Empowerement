/**
 * CertificateTemplateEditor — publisher-facing editor for
 * `localization_pack_certificate_templates`. Combines:
 *   1. First-class legal metadata (authority, legal ref, effective date,
 *      revision notes, issued-to, approval-required) mirroring the
 *      Return Template Slice A publishing surface.
 *   2. Section palette — publishers pick from the certificate_template_v2
 *      whitelist (employer_header, employee_header, fiscal_period_band,
 *      monthly_breakdown, ytd_table, totals, relief_summary,
 *      signature_block, statutory_footnote). Unknown section types can
 *      never be authored here; the DB trigger enforces the same
 *      whitelist at write time.
 *   3. Live token field inspector — save blocked while any {{token}}
 *      referenced in a section body is absent from `pack_token_registry`.
 *   4. Free-form block editor (legacy) is still available for tenants
 *      overriding a pack template — but admins are steered to sections.
 *
 * Mounted from `PackEntityTabs` for `localization_pack_certificate_templates`.
 * Save contract mirrors ReturnTemplateEditor so PackEntityTabs can
 * persist metadata columns uniformly.
 */
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Plus, Trash2, ArrowUp, ArrowDown, Loader2, ShieldCheck, Building2 } from "lucide-react";
import { toast } from "sonner";
import { TemplateFieldInspector } from "./TemplateFieldInspector";
import { CertificatePreviewPane } from "./CertificatePreviewPane";
import { TokenAwareTextarea } from "./TokenAwareTextarea";
import { useStatutoryAuthorities } from "../hooks/useStatutoryAuthorities";
import type { EditorMode } from "../types";
import { Checkbox } from "@/components/ui/checkbox";
import {
  checkCertificateCompleteness,
  resolveCompletenessRule,
} from "../lib/certificateCompleteness";
import { snippetsFor } from "../lib/statutorySnippets";
import { usePackFormatRegistry } from "../hooks/usePackFormatRegistry";
import { OutputsCard } from "./OutputsCard";

const SECTION_TYPES = [
  { value: "employer_header",    label: "Employer header",   help: "Employer name, PIN, address, tax office." },
  { value: "employee_header",    label: "Employee header",   help: "Employee identity band (name, PIN, ID, position)." },
  { value: "fiscal_period_band", label: "Fiscal period",     help: "Tax year / period-of-service band." },
  { value: "monthly_breakdown",  label: "Monthly breakdown", help: "12-row month grid pivoted by rule code." },
  { value: "ytd_table",          label: "YTD table",         help: "Generic YTD earnings-and-deductions table." },
  { value: "totals",             label: "Totals",            help: "Year-to-date totals band." },
  { value: "relief_summary",     label: "Relief summary",    help: "Personal and insurance relief lines." },
  { value: "signature_block",    label: "Signature block",   help: "Preparer + employer signature/stamp band." },
  { value: "statutory_footnote", label: "Statutory footnote",help: "Legal notice printed under the tables." },
] as const;

// Field catalogs for `include` pickers — kept in sync with the renderer
// defaults in supabase/functions/_shared/certificateSections.ts. Ordered
// the way a payroll officer expects them on the printed document.
const INCLUDE_OPTIONS: Record<string, ReadonlyArray<{ value: string; label: string }>> = {
  employer_header: [
    { value: "name",       label: "Name" },
    { value: "tax_pin",    label: "Tax PIN" },
    { value: "address",    label: "Address" },
    { value: "tax_office", label: "Tax office" },
    { value: "phone",      label: "Phone" },
    { value: "email",      label: "Email" },
  ],
  employee_header: [
    { value: "employee_number", label: "Employee number" },
    { value: "tax_pin",         label: "Tax PIN" },
    { value: "national_id",     label: "National ID" },
    { value: "position",        label: "Position" },
    { value: "department",      label: "Department" },
    { value: "hire_date",       label: "Hire date" },
  ],
  signature_block: [
    { value: "preparer",        label: "Preparer" },
    { value: "date",            label: "Date" },
    { value: "employer_stamp",  label: "Employer stamp" },
    { value: "employee_ack",    label: "Employee acknowledgement" },
  ],
};

// Common statutory rule-code chips for `monthly_breakdown`. Publishers
// can still add pack-specific codes (typing + Enter) — the picker just
// stops them typing free prose with typos.
const COMMON_RULE_CODES = [
  "gross_pay", "basic_pay", "allowances",
  "paye", "nssf", "shif", "nhif", "housing_levy",
  "insurance_relief", "personal_relief",
  "net_pay",
];

// Baseline required sections shown before we know the doc-class rule
// applies. Doc-class specific rules come from
// `resolveCompletenessRule(templateCode)` and are enforced identically
// on the server (publish gate) and here (editor).
const BASELINE_REQUIRED_SECTIONS = ["employer_header", "employee_header"] as const;

export type CertificateTemplateMetadata = {
  authority_id: string | null;
  legal_reference: string | null;
  regulation_citation: string | null;
  effective_date: string | null;
  sunset_date: string | null;
  revision_notes: string | null;
  issued_to: "employee" | "employer" | "both";
  approval_required: boolean;
  /**
   * Pack-declared export formats (ADR 0060 v2026.5.0). Array of
   * `{format, role?, label?, filename?}`. Every `format` must exist in
   * `public.format_registry` (trigger-enforced at save time). `null`
   * means "fall back to legacy body.kind dispatch".
   */
  outputs: Array<{ format: string; role?: string; label?: string | null; filename?: string | null }> | null;
};

function defaultMetadata(): CertificateTemplateMetadata {
  return {
    authority_id: null,
    legal_reference: null,
    regulation_citation: null,
    effective_date: null,
    sunset_date: null,
    revision_notes: null,
    issued_to: "employee",
    approval_required: false,
    outputs: null,
  };
}

function normalizeMetadata(input: Partial<CertificateTemplateMetadata> | null | undefined): CertificateTemplateMetadata {
  const d = defaultMetadata();
  if (!input) return d;
  return {
    authority_id:        input.authority_id ?? null,
    legal_reference:     input.legal_reference ?? null,
    regulation_citation: input.regulation_citation ?? null,
    effective_date:      input.effective_date ?? null,
    sunset_date:         input.sunset_date ?? null,
    revision_notes:      input.revision_notes ?? null,
    issued_to:           (input.issued_to as any) ?? "employee",
    approval_required:   !!input.approval_required,
    outputs:             Array.isArray(input.outputs) ? input.outputs : null,
  };
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
    metadata?: Partial<CertificateTemplateMetadata> | null;
  };
  onSave: (next: {
    body: any;
    layout: string | null;
    notes: string | null;
    metadata?: CertificateTemplateMetadata;
  }) => Promise<void> | void;
  onCancel?: () => void;
}

export function CertificateTemplateEditor({ mode, packId, initial, onSave, onCancel }: Props) {
  const editMetadata = mode === "admin" && initial.metadata !== undefined;
  const [meta, setMeta] = useState<CertificateTemplateMetadata>(() => normalizeMetadata(initial.metadata));
  const [sections, setSections] = useState<any[]>(() => {
    const b = initial.body;
    if (b && Array.isArray(b.sections)) return b.sections;
    return [];
  });
  const [dataSource] = useState<"payroll_employee_ytd">("payroll_employee_ytd");
  const [footerNote, setFooterNote] = useState<string>(() => String(initial.body?.footer_note ?? ""));
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    () => (String((initial.body as any)?.page?.orientation ?? "portrait").toLowerCase() === "landscape"
      ? "landscape" : "portrait"),
  );
  const [layout, setLayout] = useState<string>(initial.layout ?? "standard");
  const [notes, setNotes] = useState<string>(initial.notes ?? "");
  const [busy, setBusy] = useState(false);
  const unresolvedRef = useRef<string[]>([]);
  const authoritiesQuery = useStatutoryAuthorities(editMetadata ? packId : null);

  const liveBody = useMemo(() => ({
    data_source: dataSource,
    sections,
    footer_note: footerNote || undefined,
    page: { size: "a4", orientation },
  }), [sections, footerNote, dataSource, orientation]);

  const completenessRule = useMemo(
    () => resolveCompletenessRule(initial.template_code),
    [initial.template_code],
  );
  const availableSnippets = useMemo(
    () => snippetsFor(initial.template_code),
    [initial.template_code],
  );
  const completeness = useMemo(
    () => checkCertificateCompleteness(initial.template_code, liveBody),
    [initial.template_code, liveBody],
  );
  // Union baseline + doc-class rules for the UI chip list.
  const missingRequired = Array.from(
    new Set([
      ...BASELINE_REQUIRED_SECTIONS.filter(
        (t) => !sections.some((s) => s?.type === t),
      ),
      ...completeness.missing,
    ]),
  );
  const metaErrors: string[] = [];
  if (editMetadata) {
    if (!meta.authority_id) metaErrors.push("Statutory authority is required");
    if (!meta.legal_reference) metaErrors.push("Legal reference is required");
    if (!meta.effective_date) metaErrors.push("Effective date is required");
  }
  const bodyErrors: string[] = [];
  if (sections.length === 0) bodyErrors.push("Add at least one section");
  if (missingRequired.length) {
    bodyErrors.push(
      `${completenessRule.label} is missing required section(s): ${missingRequired.join(", ")}`,
    );
  }

  const canSave = () =>
    unresolvedRef.current.length === 0 &&
    metaErrors.length === 0 &&
    bodyErrors.length === 0;

  const addSection = (type: string) => {
    setSections([...sections, { type }]);
  };
  const removeSection = (i: number) => setSections(sections.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...sections];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setSections(next);
  };
  const patchSection = (i: number, patch: Record<string, any>) => {
    const next = [...sections];
    next[i] = { ...next[i], ...patch };
    setSections(next);
  };

  const doSave = async () => {
    if (!canSave()) {
      toast.error("Fix validation errors before saving");
      return;
    }
    setBusy(true);
    try {
      await onSave({
        body: liveBody,
        layout,
        notes: notes || null,
        metadata: editMetadata ? meta : undefined,
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px] lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        {/* Legal metadata */}
        {editMetadata && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Legal metadata
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Statutory authority *</Label>
                <Select
                  value={meta.authority_id ?? ""}
                  onValueChange={(v) => setMeta({ ...meta, authority_id: v || null })}
                >
                  <SelectTrigger><SelectValue placeholder="Select authority…" /></SelectTrigger>
                  <SelectContent>
                    {(authoritiesQuery.data ?? []).map((a: any) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.display_name} ({a.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Issued to</Label>
                <Select value={meta.issued_to} onValueChange={(v) => setMeta({ ...meta, issued_to: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">Employee</SelectItem>
                    <SelectItem value="employer">Employer</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label className="text-xs">Legal reference *</Label>
                <Input
                  value={meta.legal_reference ?? ""}
                  onChange={(e) => setMeta({ ...meta, legal_reference: e.target.value || null })}
                  placeholder="Income Tax Act, CAP 470"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label className="text-xs">Regulation citation</Label>
                <Input
                  value={meta.regulation_citation ?? ""}
                  onChange={(e) => setMeta({ ...meta, regulation_citation: e.target.value || null })}
                  placeholder="Section 37 — Deduction of tax from emoluments"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Effective date *</Label>
                <Input
                  type="date"
                  value={meta.effective_date ?? ""}
                  onChange={(e) => setMeta({ ...meta, effective_date: e.target.value || null })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Sunset date</Label>
                <Input
                  type="date"
                  value={meta.sunset_date ?? ""}
                  onChange={(e) => setMeta({ ...meta, sunset_date: e.target.value || null })}
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label className="text-xs">Revision notes</Label>
                <Textarea
                  rows={2}
                  value={meta.revision_notes ?? ""}
                  onChange={(e) => setMeta({ ...meta, revision_notes: e.target.value || null })}
                  placeholder="What changed in this pack version?"
                />
              </div>
              <div className="flex items-center gap-2 md:col-span-2">
                <Switch
                  checked={meta.approval_required}
                  onCheckedChange={(v) => setMeta({ ...meta, approval_required: !!v })}
                />
                <Label className="text-xs">Requires approval before issuance</Label>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pack-declared exports (ADR 0060 v2026.5.0). Publishers pick the
            set of files this certificate emits at generation time. The
            trigger `assert_outputs_formats_registered` blocks unknown
            formats at save time so the whitelist here is authoritative. */}
        {editMetadata && (
          <OutputsCard
            value={meta.outputs}
            onChange={(next) => setMeta({ ...meta, outputs: next })}
            surface="certificate"
          />
        )}

        {/* Sections */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Sections
            </CardTitle>
            <div className="flex items-center gap-1">
              <Select onValueChange={(v) => addSection(v)}>
                <SelectTrigger className="h-8 w-[210px]">
                  <SelectValue placeholder="Add section…" />
                </SelectTrigger>
                <SelectContent>
                  {SECTION_TYPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {/* Doc-class completeness card — shared with the publish gate */}
            <div className="rounded-md border bg-muted/30 p-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium">{completenessRule.label}</div>
                <Badge
                  variant={completeness.ok ? "outline" : "destructive"}
                  className="text-[10px]"
                >
                  {completeness.ok ? "Complete" : `${completeness.missing.length} missing`}
                </Badge>
              </div>
              {completenessRule.rationale && (
                <div className="text-[11px] text-muted-foreground">
                  {completenessRule.rationale}
                </div>
              )}
              {completeness.missing.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {completeness.missing.map((t) => {
                    const meta = SECTION_TYPES.find((s) => s.value === t);
                    return (
                      <Button
                        key={t}
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px]"
                        onClick={() => addSection(t)}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Add {meta?.label ?? t}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
            {sections.length === 0 && (
              <div className="text-xs text-muted-foreground">
                No sections yet. A certificate must start with an employer and employee header.
              </div>
            )}
            {sections.map((s, i) => {
              const meta = SECTION_TYPES.find((t) => t.value === s?.type);
              const unknown = !meta;
              return (
                <div key={i} className="border rounded-md p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant={unknown ? "destructive" : "outline"} className="text-[10px]">
                        {s.type}
                      </Badge>
                      <span className="text-xs text-muted-foreground truncate">
                        {meta?.help ?? "Unknown section type — will be rejected on save."}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === sections.length - 1}>
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeSection(i)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {(s.type === "monthly_breakdown" || s.type === "ytd_table") && (
                    <Input
                      className="h-8 text-xs"
                      placeholder="Title (optional)"
                      value={s.title ?? ""}
                      onChange={(e) => patchSection(i, { title: e.target.value || undefined })}
                    />
                  )}
                  {s.type === "statutory_footnote" && (
                    <div className="space-y-1.5">
                      {availableSnippets.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            Canonical wording (click to insert verbatim)
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {availableSnippets.map((snip) => (
                              <Button
                                key={snip.id}
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-6 text-[10px] px-2"
                                title={snip.body}
                                onClick={() => {
                                  const current = String(s.body ?? "").trim();
                                  const next = current
                                    ? `${current}\n\n${snip.body}`
                                    : snip.body;
                                  patchSection(i, { body: next });
                                }}
                              >
                                <Plus className="h-3 w-3 mr-1" />
                                {snip.title}
                              </Button>
                            ))}
                          </div>
                        </div>
                      )}
                      <TokenAwareTextarea
                        packId={packId ?? null}
                        rows={3}
                        value={String(s.body ?? "")}
                        onChange={(v) => patchSection(i, { body: v })}
                        placeholder="Legal notice text. Use Insert field to reference tokens."
                      />
                    </div>
                  )}
                  {INCLUDE_OPTIONS[s.type] && (
                    <div className="space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Fields to include (leave all off for the default set)
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {INCLUDE_OPTIONS[s.type].map((opt) => {
                          const current: string[] = Array.isArray(s.include) ? s.include : [];
                          const checked = current.includes(opt.value);
                          return (
                            <label
                              key={opt.value}
                              className="flex items-center gap-1.5 text-xs cursor-pointer"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(v) => {
                                  const next = v
                                    ? Array.from(new Set([...current, opt.value]))
                                    : current.filter((x) => x !== opt.value);
                                  patchSection(i, {
                                    include: next.length ? next : undefined,
                                  });
                                }}
                              />
                              {opt.label}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {s.type === "monthly_breakdown" && (
                    <div className="space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Rule codes shown as columns
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {(() => {
                          const current: string[] = Array.isArray(s.rule_codes) ? s.rule_codes : [];
                          const all = Array.from(new Set([...COMMON_RULE_CODES, ...current]));
                          return all.map((code) => {
                            const on = current.includes(code);
                            return (
                              <Button
                                key={code}
                                type="button"
                                size="sm"
                                variant={on ? "default" : "outline"}
                                className="h-6 text-[10px] px-2"
                                onClick={() => {
                                  const next = on
                                    ? current.filter((x) => x !== code)
                                    : [...current, code];
                                  patchSection(i, {
                                    rule_codes: next.length ? next : undefined,
                                  });
                                }}
                              >
                                {code}
                              </Button>
                            );
                          });
                        })()}
                      </div>
                      <Input
                        className="h-7 text-[11px]"
                        placeholder="Add a pack-specific rule code and press Enter"
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          const v = (e.target as HTMLInputElement).value.trim();
                          if (!v) return;
                          const current: string[] = Array.isArray(s.rule_codes) ? s.rule_codes : [];
                          if (!current.includes(v)) {
                            patchSection(i, { rule_codes: [...current, v] });
                          }
                          (e.target as HTMLInputElement).value = "";
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Footer + layout */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Presentation</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Layout</Label>
              <Input value={layout} onChange={(e) => setLayout(e.target.value)} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">Footer note</Label>
              <TokenAwareTextarea
                packId={packId ?? null}
                rows={2}
                value={footerNote}
                onChange={setFooterNote}
                placeholder="e.g. Kenya Revenue Authority · P9A Tax Deduction Card"
              />
            </div>
          </CardContent>
        </Card>

        {(metaErrors.length > 0 || bodyErrors.length > 0) && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Save is blocked</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5 text-xs">
                {[...metaErrors, ...bodyErrors].map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end gap-2">
          {onCancel && <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>}
          <Button onClick={doSave} disabled={busy || !canSave()}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Save template
          </Button>
        </div>
      </div>

      <div className="hidden xl:block">
        <CertificatePreviewPane
          templateCode={initial.template_code}
          displayName={initial.template_code}
          body={liveBody}
          meta={editMetadata ? {
            legal_reference: meta.legal_reference,
            regulation_citation: meta.regulation_citation,
            effective_date: meta.effective_date,
          } : null}
        />
      </div>

      <div className="space-y-3">
        <TemplateFieldInspector
          packId={packId}
          body={liveBody}
          onValidityChange={({ unresolved }) => {
            unresolvedRef.current = unresolved;
          }}
        />
        <div className="xl:hidden">
          <CertificatePreviewPane
            templateCode={initial.template_code}
            displayName={initial.template_code}
            body={liveBody}
            meta={editMetadata ? {
              legal_reference: meta.legal_reference,
              regulation_citation: meta.regulation_citation,
              effective_date: meta.effective_date,
            } : null}
          />
        </div>
      </div>
    </div>
  );
}
