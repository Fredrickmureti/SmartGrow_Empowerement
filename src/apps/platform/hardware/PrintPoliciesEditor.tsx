/**
 * PrintingSettings — Wave V3 (ADR-0008).
 *
 * Per-(business, branch, document_type) printing policy editor. Operators
 * pick a paper format (A4 / Letter / A5 / 80 mm / 58 mm) and an output
 * mode (PDF / ESC/POS) per document type. Branch-specific overrides win
 * over business-wide defaults, mirroring `resolvePrintPolicy.ts`.
 *
 * The page does NOT touch the existing A4-PDF default behaviour — a
 * business that creates no rows here keeps getting A4 PDF for everything
 * (the resolver's system fallback). This page only exists to OVERRIDE.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Printer, Trash2, AlertCircle, ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useDocumentPrintPolicies,
  DOCUMENT_TYPES,
  type PaperFormat,
  type RenderMode,
  type OutputTrigger,
  type PrintPolicy,
} from "@/hooks/useDocumentPrintPolicies";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { supabase } from "@/integrations/supabase/client";

const PAPER_OPTIONS: { value: PaperFormat; label: string }[] = [
  { value: "a4", label: "A4 (210 × 297 mm)" },
  { value: "letter", label: "US Letter" },
  { value: "a5", label: "A5" },
  { value: "80mm", label: "Thermal 80 mm — continuous roll" },
  { value: "58mm", label: "Thermal 58 mm — continuous roll" },
  { value: "40mm", label: "Thermal 40 mm — continuous roll" },
];

const RENDER_OPTIONS: { value: RenderMode; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "escpos", label: "ESC/POS (raw)" },
];

// Mirrors `resolve_output_intent`: thermal paper / ESC/POS only survives when
// the resolved role maps to a thermal-capable hardware kind.
const THERMAL_PAPER_FORMATS: ReadonlySet<PaperFormat> = new Set<PaperFormat>(["80mm", "58mm", "40mm"]);
const THERMAL_ROLE_KINDS: ReadonlySet<string> = new Set([
  "receipt_printer",
  "kitchen_printer",
  "label_printer",
]);



const TRIGGER_OPTIONS: { value: OutputTrigger; label: string; hint: string }[] = [
  { value: "manual",         label: "Manual",         hint: "Operator clicks Print. Opens preview → dispatches." },
  { value: "auto",           label: "Auto on commit", hint: "Fire immediately when the document is committed (POS receipts, kitchen tickets)." },
  { value: "preview_only",   label: "Preview only",   hint: "Never auto-dispatch to hardware; force operator confirmation." },
  { value: "download_only",  label: "Download only",  hint: "PDF download — never routed to a physical device." },
];

interface RowState {
  paper_format: PaperFormat;
  render_mode: RenderMode;
  trigger: OutputTrigger;
  role_code: string | null;
  branch_scope: "business" | string; // "business" or branch id
}

export default function PrintPoliciesEditor() {
  const { currentBusiness } = useBusinesses();
  const { branches } = useBranch();
  const permissions = usePermissions();
  const businessId = currentBusiness?.id ?? null;
  const orgId = currentBusiness?.organization_id ?? null;
  const { policies, loading, saving, upsert, remove, findPolicy } = useDocumentPrintPolicies(businessId);

  // Phase 1 — routing target is a *role* (see Printer roles module), not a
  // device. Physical device is chosen at runtime through resolve_device.
  const { data: roles = [] } = useQuery({
    enabled: !!orgId,
    queryKey: ["printer_roles_min", orgId],
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as {
        from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k2: string, v2: boolean) => { order: (c: string) => Promise<{ data: Array<{ code: string; label: string; hardware_kind: string }> | null; error: unknown }> } } } };
      })
        .from("printer_roles")
        .select("code,label,hardware_kind")
        .eq("organization_id", orgId as string)
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Audit 2026-07-28: surface the *second* silent fallback — a thermal
  // policy pointed at a role whose device physically can't take that width.
  // Read-only capability probe; `resolve_output_intent` is untouched.
  const { data: devices = [] } = useQuery({
    enabled: !!orgId,
    queryKey: ["hardware_devices_capability", orgId],
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as {
        from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: Array<{ role: string; display_name: string; supported_media_ids: string[] | null; enabled: boolean }> | null; error: unknown }> } };
      })
        .from("device_assignments")
        .select("role,display_name,supported_media_ids,enabled")
        .eq("organization_id", orgId as string);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: mediaProfiles = [] } = useQuery({
    enabled: !!orgId,
    queryKey: ["media_profiles_widths", orgId],
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as {
        from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: Array<{ id: string; width_mm: number }> | null; error: unknown }> } };
      })
        .from("media_profiles")
        .select("id,width_mm")
        .eq("org_id", orgId as string);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Per-row "draft" edits keyed by `${branch_scope}:${docType}`.
  const [drafts, setDrafts] = useState<Record<string, RowState>>({});
  const [previewDocType, setPreviewDocType] = useState<string | null>(null);

  const canWrite = permissions.canManageBusiness;
  const branchList = (branches ?? []).filter((b) => b && b.id);

  const getDraft = (branchScope: string, docType: string): RowState => {
    const key = `${branchScope}:${docType}`;
    if (drafts[key]) return drafts[key];
    const branchId = branchScope === "business" ? null : branchScope;
    const existing = findPolicy(branchId, docType);
    return {
      paper_format: existing?.paper_format ?? "a4",
      render_mode: existing?.render_mode ?? "pdf",
      trigger: (existing?.trigger as OutputTrigger | undefined) ?? "manual",
      role_code: existing?.role_code ?? null,
      branch_scope: branchScope,
    };
  };

  const setDraft = (branchScope: string, docType: string, patch: Partial<RowState>) => {
    const key = `${branchScope}:${docType}`;
    setDrafts((d) => ({ ...d, [key]: { ...getDraft(branchScope, docType), ...patch } }));
  };

  const handleSave = async (branchScope: string, docType: string) => {
    if (!businessId) return;
    const draft = getDraft(branchScope, docType);
    // Physical routing needs a role for anything that isn't download-only /
    // preview-only. If missing, warn via the "needs role" badge — Save is
    // disabled by the same predicate below.
    const policy: Omit<PrintPolicy, "id"> = {
      business_id: businessId,
      branch_id: branchScope === "business" ? null : branchScope,
      document_type: docType,
      paper_format: draft.paper_format,
      render_mode: draft.render_mode,
      trigger: draft.trigger,
      role_code: draft.role_code,
      copies: 1,
    };
    const ok = await upsert(policy);
    if (ok) {
      const key = `${branchScope}:${docType}`;
      setDrafts((d) => {
        const { [key]: _, ...rest } = d;
        return rest;
      });
    }
  };

  const handleRemove = async (branchScope: string, docType: string) => {
    const branchId = branchScope === "business" ? null : branchScope;
    const existing = findPolicy(branchId, docType);
    if (!existing?.id) return;
    await remove(existing.id);
  };

  if (!businessId) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Select a company to configure print policies.
        </CardContent>
      </Card>
    );
  }

  if (!canWrite) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Read-only
          </CardTitle>
          <CardDescription>
            Only owners, admins, and accountants can change print policies.
            You can still view the current configuration below.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderScopeMatrix = (branchScope: string, scopeLabel: string, defaultOpen = false) => (
    <Collapsible key={branchScope} defaultOpen={defaultOpen}>
      <Card>
        <CollapsibleTrigger className="w-full text-left group">
          <CardHeader className="cursor-pointer hover:bg-muted/40 transition-colors rounded-t-lg">
            <div className="flex items-center justify-between gap-2">
              <div className="flex-1">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Printer className="h-4 w-4" />
                  {scopeLabel}
                </CardTitle>
                <CardDescription>
                  {branchScope === "business"
                    ? "Default for all branches. Override per branch below."
                    : "Branch-specific override. Wins over the business default."}
                </CardDescription>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-3">
            {DOCUMENT_TYPES.map((dt) => {
              const draft = getDraft(branchScope, dt.value);
              const branchId = branchScope === "business" ? null : branchScope;
              const existing = findPolicy(branchId, dt.value);
              const draftKey = `${branchScope}:${dt.value}`;
              const dirty = !!drafts[draftKey];
              // A role is required whenever the trigger will actually reach
              // hardware. Download-only and preview-only skip role selection.
              const roleRequired = draft.trigger === "auto" || draft.trigger === "manual";
              const needsRole = roleRequired && !draft.role_code;
              // Thermal paper / ESC/POS only reaches a physical printer when
              // the selected role maps to a thermal-capable device kind.
              // Otherwise `resolve_output_intent` falls back to A4 PDF — make
              // that visible instead of letting it fail silently.
              const roleKind = roles.find((r) => r.code === draft.role_code)?.hardware_kind ?? null;
              const wantsThermal =
                draft.render_mode === "escpos" || THERMAL_PAPER_FORMATS.has(draft.paper_format);
              const thermalMismatch =
                roleRequired && wantsThermal && !!roleKind && !THERMAL_ROLE_KINDS.has(roleKind);
              return (
                <div
                  key={dt.value}
                  className="grid grid-cols-1 md:grid-cols-[1.5fr_1.2fr_1fr_1.2fr_1.3fr_auto_auto] gap-2 items-end pb-3 border-b last:border-b-0"
                >
                  <div>
                    <Label className="text-xs text-muted-foreground">{dt.label}</Label>
                    {existing && !dirty && (
                      <Badge variant="secondary" className="ml-2 text-[10px] h-4">configured</Badge>
                    )}
                    {dirty && <Badge variant="default" className="ml-2 text-[10px] h-4">unsaved</Badge>}
                    {needsRole && (
                      <Badge variant="destructive" className="ml-2 text-[10px] h-4">needs role</Badge>
                    )}
                    {thermalMismatch && (
                      <Badge
                        variant="destructive"
                        className="ml-2 text-[10px] h-4"
                        title="This document is set to thermal paper / ESC/POS, but the selected printer role targets an A4 device. It will be printed as an A4 PDF instead. Pick a thermal role (e.g. Receipt Printer) to send it to the thermal printer."
                      >
                        falls back to A4
                      </Badge>
                    )}
                  </div>

                  <Select
                    value={draft.paper_format}
                    onValueChange={(v) => setDraft(branchScope, dt.value, { paper_format: v as PaperFormat })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PAPER_OPTIONS.map((p) => (
                        <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={draft.render_mode}
                    onValueChange={(v) => setDraft(branchScope, dt.value, { render_mode: v as RenderMode })}
                  >
                    <SelectTrigger
                      className="h-8 text-xs"
                      title="How the payload is encoded. PDF for laser/inkjet, ESC/POS for thermal. Phase 2 will derive this from the target device's capability."
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RENDER_OPTIONS.map((r) => (
                        <SelectItem key={r.value} value={r.value} className="text-xs">{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Trigger — when this document reaches paper. */}
                  <Select
                    value={draft.trigger}
                    onValueChange={(v) => setDraft(branchScope, dt.value, { trigger: v as OutputTrigger })}
                  >
                    <SelectTrigger
                      className="h-8 text-xs"
                      title={TRIGGER_OPTIONS.find((t) => t.value === draft.trigger)?.hint}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRIGGER_OPTIONS.map((t) => (
                        <SelectItem key={t.value} value={t.value} className="text-xs">
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Role — semantic routing. Physical device comes from resolve_device. */}
                  <Select
                    value={draft.role_code ?? "__none__"}
                    onValueChange={(v) =>
                      setDraft(branchScope, dt.value, {
                        role_code: v === "__none__" ? null : v,
                      })
                    }
                    disabled={!roleRequired}
                  >
                    <SelectTrigger
                      className="h-8 text-xs"
                      title={
                        !roleRequired
                          ? "Download / preview triggers do not need a printer role."
                          : "Which printer role handles this document. The matching device is chosen automatically."
                      }
                    >
                      <SelectValue placeholder="— pick a role —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" className="text-xs">— none —</SelectItem>
                      {roles.map((r) => (
                        <SelectItem key={r.code} value={r.code} className="text-xs">
                          {r.label} <span className="text-muted-foreground">· {r.code}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant={dirty ? "default" : "outline"}
                    onClick={() => handleSave(branchScope, dt.value)}
                    disabled={saving || !dirty || needsRole}
                  >
                    Save
                  </Button>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPreviewDocType(dt.value)}
                      disabled={!existing}
                      title="Test print using this policy"
                    >
                      Test
                    </Button>
                    {existing && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleRemove(branchScope, dt.value)}
                        disabled={saving}
                        title="Remove override"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );

  return (
    <div className="space-y-4">
      <Card className="border-dashed">
        <CardContent className="py-3 text-xs text-muted-foreground">
          Every document flows through the same chain:
          <strong className="mx-1">policy (this page)</strong> ›
          <strong className="mx-1">printer role</strong> ›
          <strong className="mx-1">matching device assignment</strong> ›
          <strong className="mx-1">device capability</strong> ›
          <strong className="mx-1">hardware</strong>.
          Set the paper format and trigger here; the physical printer is chosen
          automatically from the selected role. Rows left blank inherit
          from the business default; blank there means <em>A4 PDF, manual</em>.
        </CardContent>
      </Card>

      {renderScopeMatrix("business", "Business default", true)}
      {branchList.length > 0 &&
        branchList.map((b) => renderScopeMatrix(b.id, `Branch override — ${b.name}`, false))}

      <PrintPreviewDialog
        open={!!previewDocType}
        onOpenChange={(o) => !o && setPreviewDocType(null)}
        title={previewDocType ? `Test ${previewDocType}` : ""}
        // Test print needs a real document id — operators run this from the
        // document page itself in practice. We surface a hint here.
        documentType={undefined}
        documentId={undefined}
        html={`<div style="padding:24px;font-family:sans-serif">
          <h3>Test print preview</h3>
          <p>Open any ${previewDocType ?? "document"} from its module and use the in-page Print button to verify the new policy.</p>
        </div>`}
      />
    </div>
  );
}
