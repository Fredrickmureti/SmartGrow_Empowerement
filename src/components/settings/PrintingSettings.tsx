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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
  type PrintPolicy,
} from "@/hooks/useDocumentPrintPolicies";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { PrinterProfilesCard } from "@/components/settings/PrinterProfilesCard";
import { usePrinterProfiles, isThermalCapable } from "@/hooks/usePrinterProfiles";

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

interface RowState {
  paper_format: PaperFormat;
  render_mode: RenderMode;
  auto_print: boolean;
  printer_profile_id: string | null;
  branch_scope: "business" | string; // "business" or branch id
}

export function PrintingSettings() {
  const { currentBusiness } = useBusinesses();
  const { branches } = useBranch();
  const permissions = usePermissions();
  const businessId = currentBusiness?.id ?? null;
  const { policies, loading, saving, upsert, remove, findPolicy } = useDocumentPrintPolicies(businessId);

  const { activeProfiles } = usePrinterProfiles(businessId);

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
      auto_print: existing?.auto_print ?? false,
      printer_profile_id: existing?.printer_profile_id ?? null,
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
    const autoPrint = docType === "pos_receipt" ? draft.auto_print : false;
    const policy: Omit<PrintPolicy, "id"> = {
      business_id: businessId,
      branch_id: branchScope === "business" ? null : branchScope,
      document_type: docType,
      paper_format: draft.paper_format,
      render_mode: draft.render_mode,
      printer_profile_id: autoPrint ? draft.printer_profile_id : null,
      auto_print: autoPrint,
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
              // Filter compatible printers: when render_mode is escpos, only thermal-capable printers.
              const compatibleProfiles = activeProfiles.filter((p) =>
                draft.render_mode === "escpos" ? isThermalCapable(p) : true,
              );
              const autoPrintEnabled = dt.value === "pos_receipt";
              const needsPrinter = autoPrintEnabled && draft.auto_print && !draft.printer_profile_id;
              return (
                <div
                  key={dt.value}
                  className="grid grid-cols-1 md:grid-cols-[1.5fr_1.3fr_0.9fr_1.3fr_auto_auto_auto] gap-2 items-end pb-3 border-b last:border-b-0"
                >
                  <div>
                    <Label className="text-xs text-muted-foreground">{dt.label}</Label>
                    {existing && !dirty && (
                      <Badge variant="secondary" className="ml-2 text-[10px] h-4">configured</Badge>
                    )}
                    {dirty && <Badge variant="default" className="ml-2 text-[10px] h-4">unsaved</Badge>}
                    {needsPrinter && (
                      <Badge variant="destructive" className="ml-2 text-[10px] h-4">needs printer</Badge>
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
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RENDER_OPTIONS.map((r) => (
                        <SelectItem key={r.value} value={r.value} className="text-xs">{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={draft.printer_profile_id ?? "__none__"}
                    onValueChange={(v) =>
                      setDraft(branchScope, dt.value, {
                        printer_profile_id: v === "__none__" ? null : v,
                      })
                    }
                    disabled={!autoPrintEnabled || !draft.auto_print}
                  >
                    <SelectTrigger
                      className="h-8 text-xs"
                      title={
                        !autoPrintEnabled
                          ? "Printer routing is only used when auto-print is enabled"
                          : !draft.auto_print
                            ? "Enable auto-print to pick a printer"
                            : "Choose which physical printer auto-print targets"
                      }
                    >
                      <SelectValue placeholder="— none —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" className="text-xs">— none (operator confirms) —</SelectItem>
                      {compatibleProfiles.map((p) => (
                        <SelectItem key={p.id} value={p.id} className="text-xs">
                          {p.label} <span className="text-muted-foreground">· {p.paper_format}</span>
                        </SelectItem>
                      ))}
                      {compatibleProfiles.length === 0 && (
                        <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
                          No compatible printers. Add one above.
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1.5" title={autoPrintEnabled ? "Auto-print receipt on transaction commit" : "Reserved for printer profiles (V6)"}>
                    <Switch
                      checked={draft.auto_print}
                      onCheckedChange={(v) => setDraft(branchScope, dt.value, { auto_print: v })}
                      disabled={!autoPrintEnabled}
                    />
                    <span className="text-[10px] text-muted-foreground">Auto</span>
                  </div>
                  <Button
                    size="sm"
                    variant={dirty ? "default" : "outline"}
                    onClick={() => handleSave(branchScope, dt.value)}
                    disabled={saving || !dirty || needsPrinter}
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
      <PrinterProfilesCard businessId={businessId} canWrite={canWrite} />

      <Card className="border-dashed">
        <CardContent className="py-3 text-xs text-muted-foreground">
          Document printing follows this resolution order:
          <strong className="mx-1">explicit override</strong> ›
          <strong className="mx-1">branch policy</strong> ›
          <strong className="mx-1">business policy</strong> ›
          <strong className="mx-1">system default (A4 PDF)</strong>.
          Leave a row unconfigured to inherit. Auto-print is wired only for
          POS receipts in this release; other document types will gain it
          alongside printer profiles.
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
