/**
 * CertificateTemplateEditor — publisher-facing editor for
 * `localization_pack_certificate_templates`.
 *
 * Certificate authoring is now a single path: the country-agnostic
 * Certificate Engine v3 document AST (`schema_version: 3`). Legacy
 * section templates and the v2 block AST were removed — there is exactly
 * one layout language, one renderer, and one editor. The live preview
 * renders through the same `compile()` pipeline that produces the filed
 * PDF, so what a publisher authors is exactly what a tenant files.
 *
 * Mounted from `PackEntityTabs`. Save contract mirrors ReturnTemplateEditor
 * so PackEntityTabs can persist metadata columns uniformly.
 */
import { useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { TemplateFieldInspector } from "./TemplateFieldInspector";
import { CertificatePreviewPane } from "./CertificatePreviewPane";
import { useStatutoryAuthorities } from "../hooks/useStatutoryAuthorities";
import type { EditorMode } from "../types";
import { OutputsCard } from "./OutputsCard";
import {
  CertificateV3Editor,
  defaultV3Body,
  validateV3Body,
  type V3Body,
  type V3Validation,
} from "./CertificateV3Editor";

export type CertificateTemplateMetadata = {
  authority_id: string | null;
  legal_reference: string | null;
  regulation_citation: string | null;
  effective_date: string | null;
  sunset_date: string | null;
  revision_notes: string | null;
  issued_to: "employee" | "employer" | "both";
  approval_required: boolean;
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
    authority_id: input.authority_id ?? null,
    legal_reference: input.legal_reference ?? null,
    regulation_citation: input.regulation_citation ?? null,
    effective_date: input.effective_date ?? null,
    sunset_date: input.sunset_date ?? null,
    revision_notes: input.revision_notes ?? null,
    issued_to: (input.issued_to as any) ?? "employee",
    approval_required: !!input.approval_required,
    outputs: Array.isArray(input.outputs) ? input.outputs : null,
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
  const [v3Body, setV3Body] = useState<V3Body>(() => {
    const b = initial.body as any;
    if (b && Number(b?.schema_version) >= 3 && Array.isArray(b?.document)) return b as V3Body;
    return defaultV3Body(initial.template_code);
  });
  const [v3Validation, setV3Validation] = useState<V3Validation>(() => validateV3Body(v3Body, []));
  const [notes, setNotes] = useState<string>(initial.notes ?? "");
  const [busy, setBusy] = useState(false);
  // WYSIWYG selection: nodeId comes back from a click in the preview canvas
  // (`doc.<i>` / `hdr.<i>` / `ftr.<i>`). It scrolls the matching inspector
  // into view and highlights it — the preview and the editor stay in sync.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const unresolvedRef = useRef<string[]>([]);
  const authoritiesQuery = useStatutoryAuthorities(editMetadata ? packId : null);

  const liveBody = v3Body;

  const metaErrors: string[] = [];
  if (editMetadata) {
    if (!meta.authority_id) metaErrors.push("Statutory authority is required");
    if (!meta.legal_reference) metaErrors.push("Legal reference is required");
    if (!meta.effective_date) metaErrors.push("Effective date is required");
  }
  const bodyErrors: string[] = [];
  if (!v3Validation.ok) {
    for (const m of v3Validation.missing) bodyErrors.push(`Document missing: ${m}`);
    for (const p of v3Validation.parseErrors) bodyErrors.push(p);
  }

  const canSave = () =>
    metaErrors.length === 0 && bodyErrors.length === 0;

  const doSave = async () => {
    if (!canSave()) {
      toast.error("Fix validation errors before saving");
      return;
    }
    setBusy(true);
    try {
      await onSave({
        body: liveBody,
        layout: "standard",
        notes: notes || null,
        metadata: editMetadata ? meta : undefined,
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  };

  // Full-viewport 3-pane layout: Canvas (live rendered document, source
  // of truth) · Inspector (structured node editors + legal metadata) ·
  // Diagnostics (field inspector for unresolved bindings). Clicking any
  // node in the Canvas selects it here and scrolls the matching editor
  // card into view — the WYSIWYG loop the previous drawer-based UI could
  // not deliver.
  const inspectorScrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll: when selection changes, find `[data-ce-editor-node="<id>"]`
  // in the inspector column and scroll it into view.
  const handleSelectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    // defer to next frame so state has propagated
    requestAnimationFrame(() => {
      const el = inspectorScrollRef.current?.querySelector(`[data-ce-editor-node="${nodeId}"]`) as HTMLElement | null;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[600px] flex-col bg-background">
      <div className="grid flex-1 min-h-0 gap-3 p-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* Canvas — the rendered document is the source of truth. */}
        <div className="min-h-0 overflow-hidden rounded-lg border bg-card">
          <CertificatePreviewPane
            templateCode={initial.template_code}
            displayName={initial.template_code}
            body={liveBody}
            selectedNodeId={selectedNodeId}
            onSelectNode={(id) => handleSelectNode(id)}
          />
        </div>

        {/* Inspector — legal metadata + structured node editors. */}
        <div ref={inspectorScrollRef} className="min-h-0 overflow-hidden rounded-lg border bg-card">
          <ScrollArea className="h-full">
            <div className="space-y-4 p-3">
              {editMetadata && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4" /> Legal metadata
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Statutory authority *</Label>
                      <Select value={meta.authority_id ?? ""} onValueChange={(v) => setMeta({ ...meta, authority_id: v || null })}>
                        <SelectTrigger><SelectValue placeholder="Select authority…" /></SelectTrigger>
                        <SelectContent>
                          {(authoritiesQuery.data ?? []).map((a: any) => (
                            <SelectItem key={a.id} value={a.id}>{a.display_name} ({a.code})</SelectItem>
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
                      <Input value={meta.legal_reference ?? ""} onChange={(e) => setMeta({ ...meta, legal_reference: e.target.value || null })} placeholder="e.g. Income Tax Act, section…" />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label className="text-xs">Regulation citation</Label>
                      <Input value={meta.regulation_citation ?? ""} onChange={(e) => setMeta({ ...meta, regulation_citation: e.target.value || null })} placeholder="e.g. Section 37 — deduction of tax from emoluments" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Effective date *</Label>
                      <Input type="date" value={meta.effective_date ?? ""} onChange={(e) => setMeta({ ...meta, effective_date: e.target.value || null })} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Sunset date</Label>
                      <Input type="date" value={meta.sunset_date ?? ""} onChange={(e) => setMeta({ ...meta, sunset_date: e.target.value || null })} />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label className="text-xs">Revision notes</Label>
                      <Textarea rows={2} value={meta.revision_notes ?? ""} onChange={(e) => setMeta({ ...meta, revision_notes: e.target.value || null })} placeholder="What changed in this pack version?" />
                    </div>
                    <div className="flex items-center gap-2 md:col-span-2">
                      <Switch checked={meta.approval_required} onCheckedChange={(v) => setMeta({ ...meta, approval_required: !!v })} />
                      <Label className="text-xs">Requires approval before issuance</Label>
                    </div>
                  </CardContent>
                </Card>
              )}

              {editMetadata && (
                <OutputsCard value={meta.outputs} onChange={(next) => setMeta({ ...meta, outputs: next })} surface="certificate" />
              )}

              <CertificateV3Editor
                templateCode={initial.template_code}
                body={v3Body}
                onChange={(next) => { setV3Body(next); setV3Validation(validateV3Body(next, [])); }}
                onValidityChange={setV3Validation}
                selectedNodeId={selectedNodeId}
                onSelectNode={(id) => setSelectedNodeId(id)}
              />

              <TemplateFieldInspector
                packId={packId}
                body={liveBody}
                onValidityChange={({ unresolved }) => { unresolvedRef.current = unresolved; }}
              />

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
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-end gap-2 border-t bg-background px-3 py-2">
        {onCancel && <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>}
        <Button onClick={doSave} disabled={busy || !canSave()}>
          {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Save template
        </Button>
      </div>
    </div>
  );
}
