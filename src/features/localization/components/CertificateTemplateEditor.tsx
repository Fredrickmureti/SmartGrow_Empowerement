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
import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertTriangle, Loader2, ShieldCheck, Plus, Layers, Type as TypeIcon, Table as TableIcon,
  Layout as LayoutIcon, Palette, Undo2, Redo2, ListTree,
} from "lucide-react";
import { toast } from "sonner";
import { TemplateFieldInspector } from "./TemplateFieldInspector";
import { CertificatePreviewPane } from "./CertificatePreviewPane";
import { ThemeInspector } from "./ThemeInspector";
import { useStatutoryAuthorities } from "../hooks/useStatutoryAuthorities";
import type { EditorMode } from "../types";
import type { Theme } from "../lib/engine/types";
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

  // ── Undo / redo history ────────────────────────────────────────────────
  // Every AST mutation goes through `commitBody(next)` which snapshots the
  // previous body onto the past stack and clears future. `undo` / `redo`
  // walk that stack. Bounded at 100 entries — enough for a full authoring
  // session, cheap in memory.
  const historyRef = useRef<{ past: V3Body[]; future: V3Body[] }>({ past: [], future: [] });
  const [, forceRender] = useState(0);
  const commitBody = (next: V3Body) => {
    historyRef.current.past.push(v3Body);
    if (historyRef.current.past.length > 100) historyRef.current.past.shift();
    historyRef.current.future = [];
    setV3Body(next);
    setV3Validation(validateV3Body(next, []));
    forceRender((n) => n + 1);
  };
  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  const undo = () => {
    const prev = historyRef.current.past.pop();
    if (!prev) return;
    historyRef.current.future.push(v3Body);
    setV3Body(prev);
    setV3Validation(validateV3Body(prev, []));
    forceRender((n) => n + 1);
  };
  const redo = () => {
    const next = historyRef.current.future.pop();
    if (!next) return;
    historyRef.current.past.push(v3Body);
    setV3Body(next);
    setV3Validation(validateV3Body(next, []));
    forceRender((n) => n + 1);
  };
  // Keyboard shortcuts — Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Skip when the user is typing in a field — undo there is native.
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v3Body]);

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

  // Toolbar Insert: append a new node to `document`. Uses the same
  // `newNode` factory the inline `+ Add node…` control uses, so every
  // primitive stays in one place (CertificateV3Editor).
  const insertNode = (type: string) => {
    const next: V3Body = {
      ...v3Body,
      document: [...(v3Body.document ?? []), (V3_NEW_NODE as any)(type)],
    };
    commitBody(next);
    // Select the newly inserted node.
    handleSelectNode(`doc.${(next.document?.length ?? 1) - 1}`);
  };

  // Direct-manipulation mutations dispatched from the Canvas.
  // The Canvas is a render surface only; every AST change lives here so
  // Undo/history/validation stay single-sourced.
  const commitDocument = (nextDoc: any[], focusIndex?: number) => {
    const next: V3Body = { ...v3Body, document: nextDoc };
    commitBody(next);
    if (focusIndex != null && focusIndex >= 0 && focusIndex < nextDoc.length) {
      handleSelectNode(`doc.${focusIndex}`);
    } else {
      setSelectedNodeId(null);
    }
  };
  const parseDocIndex = (nodeId: string) => {
    const m = /^doc\.(\d+)$/.exec(nodeId);
    return m ? Number(m[1]) : null;
  };
  const handleNodeAction = (nodeId: string, action: "moveUp" | "moveDown" | "duplicate" | "delete") => {
    const idx = parseDocIndex(nodeId);
    const doc = [...(v3Body.document ?? [])];
    if (idx == null || idx < 0 || idx >= doc.length) return;
    if (action === "delete") {
      doc.splice(idx, 1);
      commitDocument(doc, Math.min(idx, doc.length - 1));
    } else if (action === "duplicate") {
      const copy = JSON.parse(JSON.stringify(doc[idx]));
      doc.splice(idx + 1, 0, copy);
      commitDocument(doc, idx + 1);
    } else if (action === "moveUp" && idx > 0) {
      [doc[idx - 1], doc[idx]] = [doc[idx], doc[idx - 1]];
      commitDocument(doc, idx - 1);
    } else if (action === "moveDown" && idx < doc.length - 1) {
      [doc[idx + 1], doc[idx]] = [doc[idx], doc[idx + 1]];
      commitDocument(doc, idx + 1);
    }
  };
  const handleReorder = (from: number, to: number) => {
    const doc = [...(v3Body.document ?? [])];
    if (from < 0 || from >= doc.length || to < 0 || to >= doc.length) return;
    const [moved] = doc.splice(from, 1);
    doc.splice(to, 0, moved);
    commitDocument(doc, to);
  };
  // Inline WYSIWYG text edit — publisher double-clicked a heading or
  // rich-text paragraph literal in the canvas and committed a new value.
  // We update the AST literal in place, preserving all other structure.
  const handleEditText = (nodeId: string, kind: "heading" | "rich_text", text: string) => {
    const idx = parseDocIndex(nodeId);
    if (idx == null) return;
    const doc = [...(v3Body.document ?? [])];
    const node: any = JSON.parse(JSON.stringify(doc[idx]));
    if (kind === "heading" && node?.text?.kind === "literal") {
      node.text = { kind: "literal", value: text };
    } else if (kind === "rich_text" && Array.isArray(node?.paragraphs)
        && node.paragraphs.length === 1 && Array.isArray(node.paragraphs[0])
        && node.paragraphs[0].length === 1 && node.paragraphs[0][0]?.text?.kind === "literal") {
      node.paragraphs = [[{ text: { kind: "literal", value: text } }]];
    } else {
      return; // not an editable literal shape — reject silently
    }
    doc[idx] = node;
    commitDocument(doc, idx);
  };
  // Publisher clicked a block type in the "+" gutter palette — insert a
  // fresh node of that type after the source node and immediately select
  // it. Defaults to `rich_text` when the caller omits a type.
  const handleInsertAfter = (nodeId: string, nodeType?: string) => {
    const idx = parseDocIndex(nodeId);
    if (idx == null) return;
    const doc = [...(v3Body.document ?? [])];
    doc.splice(idx + 1, 0, (V3_NEW_NODE as any)(nodeType || "rich_text"));
    commitDocument(doc, idx + 1);
  };



  // Outline pane — flat list of top-level document nodes. Click to select
  // (drives the same `data-ce-node` bridge the Canvas uses).
  const documentNodes: Array<{ id: string; type: string; label: string }> = useMemo(() => {
    return (v3Body.document ?? []).map((n: any, i: number) => ({
      id: `doc.${i}`,
      type: String(n?.type ?? "?"),
      label: outlineLabelForNode(n),
    }));
  }, [v3Body.document]);

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[600px] flex-col bg-background">
      {/* Top toolbar ribbon — Insert / Structure / Theme. This is the
          Word/Excel-style command surface publishers expect on a
          design-driven page. */}
      <div className="flex items-center gap-1 border-b bg-card/70 px-3 py-1.5">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
          <Redo2 className="h-3.5 w-3.5" />
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1">
              <Plus className="h-3.5 w-3.5" /> Insert
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Text</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => insertNode("heading")}><TypeIcon className="mr-2 h-3.5 w-3.5" /> Heading</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("rich_text")}><TypeIcon className="mr-2 h-3.5 w-3.5" /> Paragraph</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("list")}>List</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Fields</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => insertNode("label_fill")}>Label + fill</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("field_row")}>Field row</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("key_value")}>Key / value</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Layout</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => insertNode("grid")}><TableIcon className="mr-2 h-3.5 w-3.5" /> Table (grid)</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("columns")}><LayoutIcon className="mr-2 h-3.5 w-3.5" /> Columns region</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("section")}>Section group</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("spacer")}>Spacer</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("page_break")}>Page break</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Statutory</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => insertNode("legal_notice")}>Legal notice</DropdownMenuItem>
            <DropdownMenuItem onClick={() => insertNode("signature_strip")}>Signature strip</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="mx-1 h-4 w-px bg-border" />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1" title="Document outline">
              <ListTree className="h-3.5 w-3.5" /> Outline
              <span className="ml-1 text-[10px] text-muted-foreground">{documentNodes.length}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" side="bottom" className="p-0 w-80">
            <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Outline
            </div>
            <ScrollArea className="max-h-[420px]">
              <div className="p-1 text-sm">
                {documentNodes.length === 0 && (
                  <div className="px-2 py-3 text-xs text-muted-foreground">
                    Empty document. Use <span className="font-medium">Insert</span> to add your first node.
                  </div>
                )}
                {documentNodes.map((n) => {
                  const active = selectedNodeId === n.id;
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => handleSelectNode(n.id)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors ${
                        active ? "bg-primary/10 text-foreground" : "hover:bg-muted"
                      }`}
                    >
                      <span className="inline-block w-14 shrink-0 text-[10px] uppercase text-muted-foreground">
                        {n.type}
                      </span>
                      <span className="truncate">{n.label}</span>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </PopoverContent>
        </Popover>
        <div className="mx-1 h-4 w-px bg-border" />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1" title="Edit pack theme tokens">
              <Palette className="h-3.5 w-3.5" /> Theme
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" side="bottom" className="p-0 w-auto">
            <ThemeInspector
              value={(v3Body as any).theme as Theme | undefined}
              onChange={(nextTheme) => commitBody({ ...v3Body, theme: nextTheme } as V3Body)}
            />
          </PopoverContent>
        </Popover>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Layers className="h-3.5 w-3.5" /> {documentNodes.length} nodes
        </div>
      </div>

      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0 gap-0 p-3">
        {/* Canvas — the rendered document is the source of truth. */}
        <ResizablePanel defaultSize={60} minSize={35}>
          <div className="h-full min-h-0 overflow-hidden rounded-lg border bg-card">
            <CertificatePreviewPane
              templateCode={initial.template_code}
              displayName={initial.template_code}
              body={liveBody}
              selectedNodeId={selectedNodeId}
              onSelectNode={(id) => handleSelectNode(id)}
              onNodeAction={handleNodeAction}
              onReorder={handleReorder}
              onEditText={handleEditText}
              onInsertAfter={handleInsertAfter}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle className="mx-2" />

        {/* Inspector — legal metadata + structured node editors. */}
        <ResizablePanel defaultSize={40} minSize={25}>
          <div ref={inspectorScrollRef} className="h-full min-h-0 overflow-hidden rounded-lg border bg-card">
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
                  onChange={(next) => commitBody(next)}
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
        </ResizablePanel>
      </ResizablePanelGroup>

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

// Best-effort label for outline entries — pulls the first literal we can
// find inside the node so publishers see "Heading — Payroll year" rather
// than "heading".
function outlineLabelForNode(n: any): string {
  if (!n) return "—";
  const seek = (v: any): string | null => {
    if (!v || typeof v !== "object") return null;
    if (v.kind === "literal" && v.value != null) return String(v.value).slice(0, 60);
    for (const k of Object.keys(v)) {
      const r = seek(v[k]);
      if (r) return r;
    }
    return null;
  };
  const label = seek(n);
  return label ?? (n.type ?? "—");
}

// Factory shared with the inline "+ Add node…" control in CertificateV3Editor.
// Kept as a local re-export so we don't leak the entire module through
// the barrel. The editor only needs it for the toolbar Insert menu.
import { newNode as V3_NEW_NODE } from "./CertificateV3Editor";
