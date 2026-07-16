/**
 * CertificateV3Editor — structured, WYSIWYG-oriented authoring surface for
 * Certificate Engine v3 templates (country-agnostic AST). No raw JSON:
 * every node, column, group, and binding is edited through typed controls,
 * and the parent's live preview renders through the exact `compile()`
 * pipeline that produces the filed PDF.
 */
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AutoGrowTextarea, CodeField, ExpandableTextField } from "@/design-system/primitives/inputs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertTriangle, FileCode2, Sparkles, Plus, Trash2, ArrowUp, ArrowDown, Link2, Type,
} from "lucide-react";
import { GridDesigner } from "./GridDesigner";
import { GENERIC_EXAMPLE_TEMPLATE } from "../lib/engine/templates/genericExample";

// ── Types ────────────────────────────────────────────────────────────────

export type PaperSize = "A4" | "A3" | "Letter" | "Legal";
export type Orientation = "portrait" | "landscape";

export interface PaperFormat {
  size: PaperSize;
  orientation: Orientation;
  margin_top: number;
  margin_right: number;
  margin_bottom: number;
  margin_left: number;
  header_height: number;
  footer_height: number;
}

export interface V3Body {
  schema_version: 3 | 4;
  code?: string;
  display_name?: string;
  paper_format: PaperFormat;
  page_master?: { code?: string; header?: any[]; footer?: any[] };
  document: any[];
  theme?: Record<string, unknown>;
}

type Value = { kind: "literal"; value: string | number } | { kind: "binding"; path: string; format?: string; fallback?: string };

export const VALUE_FORMATS = ["text", "number", "currency", "percent", "date", "month_short"];
const NODE_TYPES = [
  { value: "heading", label: "Heading" },
  { value: "rich_text", label: "Rich text / paragraph" },
  { value: "key_value", label: "Key / value" },
  { value: "identity_strip", label: "Identity strip (two columns) — legacy" },
  { value: "matrix", label: "Matrix (table) — legacy" },
  { value: "grid", label: "Grid (cell-level table)" },
  { value: "list", label: "List (numbered / bulleted)" },
  { value: "label_fill", label: "Label + fill-in value" },
  { value: "field_row", label: "Field row (inline label-fill group)" },
  { value: "columns", label: "Columns (multi-column region)" },
  { value: "legal_notice", label: "Legal notice" },
  { value: "signature_strip", label: "Signature strip" },
  { value: "section", label: "Section (group)" },
  { value: "spacer", label: "Spacer" },
  { value: "page_break", label: "Page break" },
];

export function defaultV3Body(templateCode: string): V3Body {
  return {
    schema_version: 4,
    code: templateCode,
    paper_format: {
      size: "A4", orientation: "portrait",
      margin_top: 14, margin_right: 12, margin_bottom: 12, margin_left: 12,
      header_height: 14, footer_height: 10,
    },
    page_master: { code: `${templateCode.toLowerCase()}.page_master.v1`, header: [], footer: [] },
    document: [],
  };
}

// ── Validation (semantic — v3 legacy + v4 primitives) ───────────────────
//
// A statutory certificate template is saveable when the AST contains the
// three *semantic roles* every filing needs:
//   1. an identity block that binds employer AND employee facts
//   2. a signature area
//   3. a tabular data block (monthly grid, ledger, etc.)
//
// These roles can be satisfied by v3 legacy primitives (identity_strip /
// signature_strip / matrix) OR by v4 primitives (label_fill/field_row
// bound to employer.* + employee.*, a signature_strip or a label_fill
// block containing a "Signature" caption, and a grid). This keeps the
// validator from false-negatively rejecting v4-only templates such as
// the canonical statutory template shipped by a localization pack.

export interface V3Validation {
  ok: boolean;
  missing: string[];
  parseErrors: string[];
}

function collectNodes(nodes: any[], out: any[] = []): any[] {
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object") continue;
    out.push(n);
    if (Array.isArray(n.children)) collectNodes(n.children, out);
    if (Array.isArray(n.column_children)) {
      for (const col of n.column_children) collectNodes(col, out);
    }
    if (Array.isArray(n.fields)) collectNodes(n.fields, out);
    if (n.items && Array.isArray(n.items)) {
      // list items may recurse via `children` sublists
      for (const it of n.items) if (it?.children) collectNodes([it.children], out);
    }
  }
  return out;
}

function bindingPathsIn(v: any, acc: string[] = []): string[] {
  if (!v || typeof v !== "object") return acc;
  if (v.kind === "binding" && typeof v.path === "string") acc.push(v.path);
  for (const k of Object.keys(v)) bindingPathsIn(v[k], acc);
  return acc;
}

export function validateV3Body(body: Partial<V3Body>, parseErrors: string[] = []): V3Validation {
  const missing: string[] = [];
  if (!body.paper_format) missing.push("paper_format");
  const doc = Array.isArray(body.document) ? body.document : [];
  if (doc.length === 0) missing.push("non-empty document");

  const all = collectNodes(doc);
  const hasType = (t: string) => all.some((n) => n?.type === t);

  // Identity role — legacy identity_strip OR any label_fill/field_row/kv
  // that binds to BOTH employer.* and employee.*.
  const allBindings = bindingPathsIn(doc);
  const bindsEmployer = allBindings.some((p) => p.startsWith("employer."));
  const bindsEmployee = allBindings.some((p) => p.startsWith("employee."));
  const hasIdentity = hasType("identity_strip") || (bindsEmployer && bindsEmployee);
  if (!hasIdentity) missing.push("identity block (identity_strip or employer+employee bindings)");

  // Signature role — legacy signature_strip OR any node whose text
  // contains "Signature"/"Signed" (pack-authored caption).
  const literalsIn = (v: any, acc: string[] = []): string[] => {
    if (!v || typeof v !== "object") return acc;
    if (v.kind === "literal" && v.value != null) acc.push(String(v.value));
    for (const k of Object.keys(v)) literalsIn(v[k], acc);
    return acc;
  };
  const literals = literalsIn(doc).join(" ").toLowerCase();
  const hasSignature = hasType("signature_strip") || /\bsign(ed|ature)?\b/.test(literals);
  if (!hasSignature) missing.push("signature block (signature_strip or a caption containing 'Signature')");

  // Tabular role — legacy matrix OR v4 grid.
  const hasTable = hasType("matrix") || hasType("grid");
  if (!hasTable) missing.push("tabular data block (matrix or grid)");

  return { ok: missing.length === 0 && parseErrors.length === 0, missing, parseErrors };
}

// ── Value editor ─────────────────────────────────────────────────────────

export function ValueEditor({ value, onChange, placeholder }: {
  value: Value | undefined;
  onChange: (v: Value) => void;
  placeholder?: string;
}) {
  const v: Value = value ?? { kind: "literal", value: "" };
  const isBinding = v.kind === "binding";
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button" size="sm" variant="ghost" className="h-7 px-1.5"
        title={isBinding ? "Data binding — click for static text" : "Static text — click for data binding"}
        onClick={() => onChange(isBinding
          ? { kind: "literal", value: "" }
          : { kind: "binding", path: "" })}
      >
        {isBinding ? <Link2 className="h-3.5 w-3.5 text-primary" /> : <Type className="h-3.5 w-3.5 text-muted-foreground" />}
      </Button>
      {isBinding ? (
        <>
          <CodeField
            className="h-7"
            placeholder="payload.path e.g. employer.name"
            value={(v as any).path ?? ""}
            onChange={(next) => onChange({ ...v, kind: "binding", path: next } as Value)}
          />
          <Select
            value={(v as any).format ?? "text"}
            onValueChange={(f) => onChange({ ...v, kind: "binding", format: f } as Value)}
          >
            <SelectTrigger className="h-7 w-[92px] text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {VALUE_FORMATS.map((f) => <SelectItem key={f} value={f} className="text-xs">{f}</SelectItem>)}
            </SelectContent>
          </Select>
        </>
      ) : (
        <ExpandableTextField
          value={String((v as any).value ?? "")}
          onChange={(next) => onChange({ kind: "literal", value: next })}
          placeholder={placeholder ?? "Static text"}
          dialogTitle="Edit literal text"
        />
      )}
    </div>
  );
}

// ── Node list editor (used for document, page header/footer, section) ─────

function NodeListEditor({ nodes, onChange, allow, scope, selectedNodeId, onSelectNode }: {
  nodes: any[];
  onChange: (next: any[]) => void;
  allow?: string[];
  /** WYSIWYG scope prefix so cards match `data-ce-node` ids from compile(). */
  scope?: string;
  selectedNodeId?: string | null;
  onSelectNode?: (id: string) => void;
}) {
  const types = allow ? NODE_TYPES.filter((t) => allow.includes(t.value)) : NODE_TYPES;
  const add = (type: string) => onChange([...(nodes ?? []), newNode(type)]);
  const patch = (i: number, next: any) => {
    const copy = [...nodes]; copy[i] = next; onChange(copy);
  };
  const remove = (i: number) => onChange(nodes.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= nodes.length) return;
    const copy = [...nodes]; [copy[i], copy[j]] = [copy[j], copy[i]]; onChange(copy);
  };
  return (
    <div className="space-y-2">
      {(nodes ?? []).map((n, i) => {
        const nodeId = scope ? `${scope}.${i}` : undefined;
        const isSelected = nodeId && selectedNodeId === nodeId;
        return (
          <div
            key={i}
            data-ce-editor-node={nodeId}
            className={`rounded-md border p-2 space-y-2 bg-card transition-colors ${isSelected ? "ring-2 ring-primary border-primary" : ""}`}
            onFocus={() => nodeId && onSelectNode?.(nodeId)}
            tabIndex={-1}
          >
            <div className="flex items-center justify-between gap-2">
              <Badge variant="outline" className="text-[10px]">{n?.type ?? "?"}</Badge>
              <div className="flex items-center gap-0.5">
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => move(i, 1)} disabled={i === nodes.length - 1}><ArrowDown className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => remove(i)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            <NodeEditor node={n} onChange={(next) => patch(i, next)} />
          </div>
        );
      })}
      <Select onValueChange={add}>
        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="+ Add node…" /></SelectTrigger>
        <SelectContent>
          {types.map((t) => <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

export function newNode(type: string): any {
  switch (type) {
    case "heading": return { type: "heading", level: 2, align: "left", text: { kind: "literal", value: "Heading" } };
    case "rich_text": return { type: "rich_text", align: "left", paragraphs: [[{ text: { kind: "literal", value: "Text" } }]] };
    case "key_value": return { type: "key_value", label: { kind: "literal", value: "Label" }, value: { kind: "binding", path: "" } };
    case "identity_strip": return { type: "identity_strip", left_title: { kind: "literal", value: "Left" }, right_title: { kind: "literal", value: "Right" }, left: [], right: [] };
    case "matrix": return { type: "matrix", title: { kind: "literal", value: "Table" }, rows_binding: "", repeat_header: true, columns: [], column_groups: [], footer: null };
    case "grid": return { type: "grid", columns: [], header_rows: [], data_rows: { bind: "" }, footer_rows: [], repeat_header: true, border: "all", zebra: "none" };
    case "list": return { type: "list", marker: "decimal", compact: true, items: [{ text: { kind: "literal", value: "Item" } }] };
    case "label_fill": return { type: "label_fill", label: { kind: "literal", value: "Label" }, value: { kind: "binding", path: "" }, rule: "dotted" };
    case "field_row": return { type: "field_row", gap_mm: 6, fields: [] };
    case "columns": return { type: "columns", count: 2, gap_mm: 6, column_children: [[], []] };
    case "page_break": return { type: "page_break" };
    case "legal_notice": return { type: "legal_notice", title: { kind: "literal", value: "Notice" }, border: true, paragraphs: [{ kind: "literal", value: "…" }] };
    case "signature_strip": return { type: "signature_strip", slots: [{ caption: { kind: "literal", value: "Signature" } }] };
    case "section": return { type: "section", title: { kind: "literal", value: "Section" }, keep_together: true, children: [] };
    case "spacer": return { type: "spacer", size_mm: 4 };
    default: return { type };
  }
}

// ── Per-node editors ─────────────────────────────────────────────────────

function NodeEditor({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const set = (patch: any) => onChange({ ...node, ...patch });
  switch (node.type) {
    case "heading":
      return (
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
          <ValueEditor value={node.text} onChange={(v) => set({ text: v })} />
          <Select value={String(node.level ?? 2)} onValueChange={(l) => set({ level: Number(l) })}>
            <SelectTrigger className="h-7 w-[64px] text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{[1, 2, 3].map((l) => <SelectItem key={l} value={String(l)} className="text-xs">H{l}</SelectItem>)}</SelectContent>
          </Select>
          <AlignSelect value={node.align} onChange={(a) => set({ align: a })} />
        </div>
      );
    case "rich_text":
      return (
        <div className="space-y-1">
          <AlignSelect value={node.align} onChange={(a) => set({ align: a })} />
          <AutoGrowTextarea
            className="text-xs"
            minRows={2}
            value={(node.paragraphs ?? []).map((runs: any[]) => runs.map((r) => r.text?.value ?? "").join("")).join("\n")}
            onChange={(e) => set({
              paragraphs: e.target.value.split("\n").map((line) => [{ text: { kind: "literal", value: line } }]),
            })}
            placeholder="One paragraph per line (static text)"
          />
        </div>
      );
    case "key_value":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div><Label className="text-[10px]">Label</Label><ValueEditor value={node.label} onChange={(v) => set({ label: v })} /></div>
          <div><Label className="text-[10px]">Value</Label><ValueEditor value={node.value} onChange={(v) => set({ value: v })} /></div>
        </div>
      );
    case "identity_strip":
      return (
        <div className="grid grid-cols-2 gap-3">
          {(["left", "right"] as const).map((side) => (
            <div key={side} className="space-y-1">
              <ValueEditor value={node[`${side}_title`]} onChange={(v) => set({ [`${side}_title`]: v })} placeholder={`${side} title`} />
              <KeyValueListEditor items={node[side] ?? []} onChange={(items) => set({ [side]: items })} />
            </div>
          ))}
        </div>
      );
    case "matrix":
      return <MatrixEditor node={node} onChange={onChange} />;
    case "legal_notice":
      return (
        <div className="space-y-1">
          <ValueEditor value={node.title} onChange={(v) => set({ title: v })} placeholder="Title" />
          <AutoGrowTextarea
            className="text-xs"
            minRows={3}
            value={(node.paragraphs ?? []).map((p: any) => p?.value ?? "").join("\n")}
            onChange={(e) => set({ paragraphs: e.target.value.split("\n").map((l) => ({ kind: "literal", value: l })) })}
            placeholder="One paragraph per line"
          />
        </div>
      );
    case "signature_strip":
      return <SignatureEditor node={node} onChange={onChange} />;
    case "section":
      return (
        <div className="space-y-2">
          <ValueEditor value={node.title} onChange={(v) => set({ title: v })} placeholder="Section title" />
          <div className="pl-2 border-l-2">
            <NodeListEditor nodes={node.children ?? []} onChange={(children) => set({ children })} />
          </div>
        </div>
      );
    case "spacer":
      return (
        <div className="flex items-center gap-2">
          <Label className="text-[10px]">Height (mm)</Label>
          <Input type="number" className="h-7 w-20 text-xs" value={node.size_mm ?? 4} onChange={(e) => set({ size_mm: Number(e.target.value) || 0 })} />
        </div>
      );
    case "page_break":
      return <div className="text-[10px] text-muted-foreground italic">Forces a new page at this position.</div>;
    case "list":
      return <ListEditor node={node} onChange={onChange} />;
    case "label_fill":
      return <LabelFillEditor node={node} onChange={onChange} />;
    case "field_row":
      return <FieldRowEditor node={node} onChange={onChange} />;
    case "columns":
      return <ColumnsEditor node={node} onChange={onChange} />;
    case "grid":
      return <GridDesigner node={node} onChange={onChange} />;
    default:
      return <div className="text-[11px] text-muted-foreground">No editor for “{node.type}”.</div>;
  }
}

// ── v4 node editors ──────────────────────────────────────────────────────

const LIST_MARKERS = [
  "decimal", "decimal-paren", "lower-alpha", "lower-alpha-paren",
  "upper-alpha", "lower-roman", "lower-roman-paren", "upper-roman",
  "disc", "circle", "square", "none",
];

function ListEditor({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const items: any[] = node.items ?? [];
  const set = (patch: any) => onChange({ ...node, ...patch });
  const patchItem = (i: number, next: any) => { const c = [...items]; c[i] = next; set({ items: c }); };
  const remove = (i: number) => set({ items: items.filter((_, idx) => idx !== i) });
  const move = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= items.length) return; const c = [...items]; [c[i], c[j]] = [c[j], c[i]]; set({ items: c }); };
  const add = () => set({ items: [...items, { text: { kind: "literal", value: "Item" } }] });
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
        <div>
          <Label className="text-[10px]">Marker</Label>
          <Select value={node.marker ?? "decimal"} onValueChange={(m) => set({ marker: m })}>
            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{LIST_MARKERS.map((m) => <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[10px]">Start</Label>
          <Input type="number" className="h-7 w-16 text-xs" value={node.start ?? 1} onChange={(e) => set({ start: Number(e.target.value) || 1 })} />
        </div>
        <label className="flex items-center gap-1 text-[11px] pt-4">
          <input type="checkbox" checked={!!node.compact} onChange={(e) => set({ compact: e.target.checked })} /> compact
        </label>
      </div>
      <div className="space-y-1">
        {items.map((it, i) => (
          <div key={i} className="flex items-start gap-1">
            <div className="flex-1 space-y-1">
              <ValueEditor value={it.text} onChange={(v) => patchItem(i, { ...it, text: v })} placeholder="Item text" />
              {it.children && (
                <div className="pl-4 border-l-2 mt-1">
                  <ListEditor node={it.children} onChange={(next) => patchItem(i, { ...it, children: next })} />
                </div>
              )}
            </div>
            <div className="flex flex-col">
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => move(i, 1)} disabled={i === items.length - 1}><ArrowDown className="h-3 w-3" /></Button>
              <Button
                size="sm" variant="ghost" className="h-6 w-6 p-0"
                title={it.children ? "Remove sublist" : "Add sublist"}
                onClick={() => patchItem(i, it.children
                  ? { ...it, children: undefined }
                  : { ...it, children: { type: "list", marker: "lower-alpha", compact: true, items: [{ text: { kind: "literal", value: "Sub-item" } }] } })}
              ><Plus className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => remove(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={add}><Plus className="h-3 w-3 mr-1" />Add item</Button>
      </div>
    </div>
  );
}

const RULE_STYLES = ["dotted", "solid", "dashed", "none"];

function LabelFillEditor({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const set = (patch: any) => onChange({ ...node, ...patch });
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <Label className="text-[10px]">Label</Label>
        <ValueEditor value={node.label} onChange={(v) => set({ label: v })} placeholder="Label" />
      </div>
      <div>
        <Label className="text-[10px]">Value</Label>
        <ValueEditor value={node.value} onChange={(v) => set({ value: v })} placeholder="Value" />
      </div>
      <div>
        <Label className="text-[10px]">Rule</Label>
        <Select value={node.rule ?? "dotted"} onValueChange={(r) => set({ rule: r })}>
          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>{RULE_STYLES.map((r) => <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-[10px]">Value width</Label>
        <Input className="h-7 text-xs" value={node.value_width ?? ""}
          onChange={(e) => { const v = e.target.value; set({ value_width: v === "" ? undefined : (/^\d+$/.test(v) ? Number(v) : v) }); }}
          placeholder="e.g. 60 (mm) or 1fr" />
      </div>
      <label className="flex items-center gap-1 text-[11px]">
        <input type="checkbox" checked={!!node.label_bold} onChange={(e) => set({ label_bold: e.target.checked })} /> label bold
      </label>
    </div>
  );
}

function FieldRowEditor({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const fields: any[] = node.fields ?? [];
  const set = (patch: any) => onChange({ ...node, ...patch });
  const patchField = (i: number, next: any) => { const c = [...fields]; c[i] = next; set({ fields: c }); };
  const add = () => set({ fields: [...fields, { type: "label_fill", label: { kind: "literal", value: "Label" }, value: { kind: "binding", path: "" }, rule: "dotted" }] });
  const remove = (i: number) => set({ fields: fields.filter((_, idx) => idx !== i) });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-[10px]">Gap (mm)</Label>
        <Input type="number" className="h-7 w-16 text-xs" value={node.gap_mm ?? 6} onChange={(e) => set({ gap_mm: Number(e.target.value) || 0 })} />
      </div>
      <div className="space-y-1">
        {fields.map((f, i) => (
          <div key={i} className="rounded border p-2 space-y-1 bg-muted/30">
            <div className="flex justify-between">
              <Badge variant="outline" className="text-[10px]">field {i + 1}</Badge>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => remove(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
            <LabelFillEditor node={f} onChange={(next) => patchField(i, next)} />
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={add}><Plus className="h-3 w-3 mr-1" />Add field</Button>
      </div>
    </div>
  );
}

function ColumnsEditor({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const set = (patch: any) => onChange({ ...node, ...patch });
  const count = Math.max(1, Number(node.count ?? 2));
  const cc: any[][] = Array.isArray(node.column_children)
    ? [...node.column_children]
    : Array.from({ length: count }, () => [] as any[]);
  while (cc.length < count) cc.push([]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div>
          <Label className="text-[10px]">Column count</Label>
          <Input type="number" min={1} max={6} className="h-7 w-16 text-xs" value={count}
            onChange={(e) => {
              const n = Math.max(1, Math.min(6, Number(e.target.value) || 1));
              const next = [...cc];
              while (next.length < n) next.push([]);
              next.length = n;
              set({ count: n, column_children: next });
            }} />
        </div>
        <div>
          <Label className="text-[10px]">Gap (mm)</Label>
          <Input type="number" className="h-7 w-16 text-xs" value={node.gap_mm ?? 6} onChange={(e) => set({ gap_mm: Number(e.target.value) || 0 })} />
        </div>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
        {cc.slice(0, count).map((children, i) => (
          <div key={i} className="rounded border p-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Column {i + 1}</div>
            <NodeListEditor
              nodes={children ?? []}
              onChange={(next) => { const c = [...cc]; c[i] = next; set({ column_children: c }); }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const CELL_VARIANTS: string[] = ["plain", "label", "unit", "letter", "note", "total"];
const BORDER_MODES: string[] = ["all", "outer", "none"];
const ZEBRA_MODES: string[] = ["none", "even", "odd"];

function GridEditor({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const set = (patch: any) => onChange({ ...node, ...patch });
  const cols: any[] = node.columns ?? [];
  const headerRows: any[][] = node.header_rows ?? [];
  const footerRows: any[][] = node.footer_rows ?? [];
  const dataRows = node.data_rows ?? { bind: "" };

  const patchCol = (i: number, next: any) => { const c = [...cols]; c[i] = next; set({ columns: c }); };
  const addCol = () => set({ columns: [...cols, { id: `col_${cols.length + 1}`, align: "right", format: "number" }] });
  const removeCol = (i: number) => set({ columns: cols.filter((_, idx) => idx !== i) });
  const moveCol = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= cols.length) return; const c = [...cols]; [c[i], c[j]] = [c[j], c[i]]; set({ columns: c }); };

  const setHeaderRows = (next: any[][]) => set({ header_rows: next });
  const setFooterRows = (next: any[][]) => set({ footer_rows: next });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[10px]">Title</Label>
          <ValueEditor value={node.title} onChange={(v) => set({ title: v })} placeholder="Grid title" />
        </div>
        <div>
          <Label className="text-[10px]">Data rows — bind (array path)</Label>
          <CodeField value={dataRows.bind ?? ""} onChange={(v) => set({ data_rows: { ...dataRows, bind: v } })} placeholder="e.g. rows.items" />
        </div>
        <div>
          <Label className="text-[10px]">Border</Label>
          <Select value={node.border ?? "all"} onValueChange={(b) => set({ border: b })}>
            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{BORDER_MODES.map((b) => <SelectItem key={b} value={b} className="text-xs">{b}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[10px]">Zebra</Label>
          <Select value={node.zebra ?? "none"} onValueChange={(z) => set({ zebra: z })}>
            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{ZEBRA_MODES.map((z) => <SelectItem key={z} value={z} className="text-xs">{z}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      {/* Columns */}
      <div className="rounded border">
        <div className="grid grid-cols-[80px_60px_60px_1fr_44px] gap-1 px-1 py-1 text-[9px] uppercase tracking-wide text-muted-foreground border-b">
          <span>ID</span><span>Align</span><span>Format</span><span>Width · nowrap · bind_key</span><span></span>
        </div>
        {cols.map((c, i) => (
          <div key={i} className="grid grid-cols-[80px_60px_60px_1fr_44px] gap-1 px-1 py-1 items-center border-b last:border-b-0">
            <CodeField value={c.id ?? ""} onChange={(v) => patchCol(i, { ...c, id: v })} />
            <Select value={c.align ?? "right"} onValueChange={(a) => patchCol(i, { ...c, align: a })}>
              <SelectTrigger className="h-7 text-[10px] px-1"><SelectValue /></SelectTrigger>
              <SelectContent>{["left", "center", "right"].map((a) => <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={c.format ?? "number"} onValueChange={(f) => patchCol(i, { ...c, format: f })}>
              <SelectTrigger className="h-7 text-[10px] px-1"><SelectValue /></SelectTrigger>
              <SelectContent>{VALUE_FORMATS.map((f) => <SelectItem key={f} value={f} className="text-xs">{f}</SelectItem>)}</SelectContent>
            </Select>
            <div className="flex gap-1 items-center">
              <Input className="h-7 w-16 text-[11px]" value={c.width ?? ""}
                onChange={(e) => { const v = e.target.value; patchCol(i, { ...c, width: v === "" ? undefined : (/^\d+$/.test(v) ? Number(v) : v) }); }}
                placeholder="w" />
              <label className="flex items-center gap-1 text-[10px]">
                <input type="checkbox" checked={!!c.nowrap} onChange={(e) => patchCol(i, { ...c, nowrap: e.target.checked })} /> nowrap
              </label>
              <CodeField value={c.bind_key ?? ""} onChange={(v) => patchCol(i, { ...c, bind_key: v || undefined })} placeholder="bind_key (default = id)" />
            </div>
            <div className="flex">
              <Button size="sm" variant="ghost" className="h-6 w-5 p-0" onClick={() => moveCol(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-5 p-0" onClick={() => moveCol(i, 1)} disabled={i === cols.length - 1}><ArrowDown className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-5 p-0 text-destructive" onClick={() => removeCol(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
        ))}
        <div className="p-1"><Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={addCol}><Plus className="h-3 w-3 mr-1" />Add column</Button></div>
      </div>

      {/* Header rows */}
      <HeaderFooterRowsEditor
        label="Header rows"
        rows={headerRows}
        onChange={setHeaderRows}
        allowSumOf={false}
      />

      {/* Footer rows */}
      <HeaderFooterRowsEditor
        label="Footer rows"
        rows={footerRows}
        onChange={setFooterRows}
        allowSumOf
        columnIds={cols.map((c: any) => c.id).filter(Boolean)}
      />

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={node.repeat_header !== false} onChange={(e) => set({ repeat_header: e.target.checked })} />
        Repeat header row on each page
      </label>
    </div>
  );
}

function HeaderFooterRowsEditor({
  label, rows, onChange, allowSumOf, columnIds,
}: {
  label: string;
  rows: any[][];
  onChange: (n: any[][]) => void;
  allowSumOf: boolean;
  columnIds?: string[];
}) {
  const addRow = () => onChange([...(rows ?? []), []]);
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const patchRow = (i: number, next: any[]) => { const c = [...rows]; c[i] = next; onChange(c); };
  const addCell = (rowIdx: number) => {
    const cell = { span: 1, content: { kind: "literal", value: "" }, variant: "plain" };
    patchRow(rowIdx, [...(rows[rowIdx] ?? []), cell]);
  };
  const patchCell = (rowIdx: number, cellIdx: number, next: any) => {
    const row = [...(rows[rowIdx] ?? [])]; row[cellIdx] = next; patchRow(rowIdx, row);
  };
  const removeCell = (rowIdx: number, cellIdx: number) =>
    patchRow(rowIdx, (rows[rowIdx] ?? []).filter((_, idx) => idx !== cellIdx));

  return (
    <div className="rounded border p-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={addRow}><Plus className="h-3 w-3 mr-1" />Add row</Button>
      </div>
      {(rows ?? []).map((row, rowIdx) => (
        <div key={rowIdx} className="rounded border p-1 space-y-1 bg-muted/20">
          <div className="flex items-center justify-between">
            <Badge variant="outline" className="text-[10px]">row {rowIdx + 1}</Badge>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => addCell(rowIdx)}><Plus className="h-3 w-3" /> cell</Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => removeRow(rowIdx)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
          <div className="space-y-1">
            {(row ?? []).map((cell, cellIdx) => {
              const isSumOf = cell?.content && typeof cell.content === "object" && cell.content.kind === "sum_of";
              return (
                <div key={cellIdx} className="grid grid-cols-[46px_60px_70px_1fr_28px] gap-1 items-center">
                  <Input type="number" min={1} className="h-7 text-[11px]" value={cell.span ?? 1} onChange={(e) => patchCell(rowIdx, cellIdx, { ...cell, span: Number(e.target.value) || 1 })} title="colspan" />
                  <Input type="number" min={1} className="h-7 text-[11px]" value={cell.row_span ?? 1} onChange={(e) => patchCell(rowIdx, cellIdx, { ...cell, row_span: Number(e.target.value) || 1 })} title="rowspan" />
                  <Select value={cell.variant ?? "plain"} onValueChange={(v) => patchCell(rowIdx, cellIdx, { ...cell, variant: v })}>
                    <SelectTrigger className="h-7 text-[10px] px-1"><SelectValue /></SelectTrigger>
                    <SelectContent>{CELL_VARIANTS.map((v) => <SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>)}</SelectContent>
                  </Select>
                  {allowSumOf && isSumOf ? (
                    <div className="flex gap-1 items-center">
                      <Badge variant="secondary" className="text-[10px]">Σ</Badge>
                      <Select
                        value={cell.content.column_id ?? ""}
                        onValueChange={(id) => patchCell(rowIdx, cellIdx, { ...cell, content: { ...cell.content, kind: "sum_of", column_id: id } })}
                      >
                        <SelectTrigger className="h-7 text-[11px]"><SelectValue placeholder="column" /></SelectTrigger>
                        <SelectContent>{(columnIds ?? []).map((id) => <SelectItem key={id} value={id} className="text-xs font-mono">{id}</SelectItem>)}</SelectContent>
                      </Select>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => patchCell(rowIdx, cellIdx, { ...cell, content: { kind: "literal", value: "" } })}>text</Button>
                    </div>
                  ) : (
                    <div className="flex gap-1 items-center">
                      <ValueEditor value={cell.content as any} onChange={(v) => patchCell(rowIdx, cellIdx, { ...cell, content: v })} placeholder="cell content" />
                      {allowSumOf && (
                        <Button size="sm" variant="ghost" className="h-6 text-[10px]" title="Convert to sum_of"
                          onClick={() => patchCell(rowIdx, cellIdx, { ...cell, content: { kind: "sum_of", column_id: (columnIds ?? [])[0] ?? "" } })}
                        >Σ</Button>
                      )}
                    </div>
                  )}
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => removeCell(rowIdx, cellIdx)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function AlignSelect({ value, onChange }: { value?: string; onChange: (a: string) => void }) {
  return (
    <Select value={value ?? "left"} onValueChange={onChange}>
      <SelectTrigger className="h-7 w-[84px] text-[11px]"><SelectValue /></SelectTrigger>
      <SelectContent>
        {["left", "center", "right"].map((a) => <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function KeyValueListEditor({ items, onChange }: { items: any[]; onChange: (n: any[]) => void }) {
  const add = () => onChange([...(items ?? []), { type: "key_value", label: { kind: "literal", value: "" }, value: { kind: "binding", path: "" } }]);
  const patch = (i: number, next: any) => { const c = [...items]; c[i] = next; onChange(c); };
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  return (
    <div className="space-y-1">
      {(items ?? []).map((kv, i) => (
        <div key={i} className="flex items-center gap-1">
          <ValueEditor value={kv.label} onChange={(v) => patch(i, { ...kv, label: v })} placeholder="Label" />
          <ValueEditor value={kv.value} onChange={(v) => patch(i, { ...kv, value: v })} placeholder="Value" />
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => remove(i)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={add}><Plus className="h-3 w-3 mr-1" />Add row</Button>
    </div>
  );
}

function SignatureEditor({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const slots = node.slots ?? [];
  const set = (next: any[]) => onChange({ ...node, slots: next });
  return (
    <div className="space-y-1">
      {slots.map((s: any, i: number) => (
        <div key={i} className="flex items-center gap-1">
          <ValueEditor value={s.caption} onChange={(v) => { const c = [...slots]; c[i] = { ...s, caption: v }; set(c); }} placeholder="Caption" />
          <ValueEditor value={s.sub_caption} onChange={(v) => { const c = [...slots]; c[i] = { ...s, sub_caption: v }; set(c); }} placeholder="Sub-caption" />
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => set(slots.filter((_: any, idx: number) => idx !== i))}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => set([...slots, { caption: { kind: "literal", value: "Signature" } }])}><Plus className="h-3 w-3 mr-1" />Add slot</Button>
    </div>
  );
}

// ── Matrix editor ────────────────────────────────────────────────────────

function MatrixEditor({ node, onChange }: { node: any; onChange: (n: any) => void }) {
  const set = (patch: any) => onChange({ ...node, ...patch });
  const cols: any[] = node.columns ?? [];
  const patchCol = (i: number, next: any) => { const c = [...cols]; c[i] = next; set({ columns: c }); };
  const addCol = () => set({ columns: [...cols, { key: `col_${cols.length + 1}`, header: { kind: "literal", value: "Col" }, align: "right", format: "number" }] });
  const removeCol = (i: number) => set({ columns: cols.filter((_, idx) => idx !== i) });
  const moveCol = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= cols.length) return; const c = [...cols]; [c[i], c[j]] = [c[j], c[i]]; set({ columns: c }); };

  const groups: any[] = node.column_groups ?? [];
  const footer = node.footer ?? null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[10px]">Rows binding (array path)</Label>
          <Input className="h-7 text-xs font-mono" value={node.rows_binding ?? ""} onChange={(e) => set({ rows_binding: e.target.value })} placeholder="e.g. rows.items" />
        </div>
        <div>
          <Label className="text-[10px]">Title</Label>
          <ValueEditor value={node.title} onChange={(v) => set({ title: v })} placeholder="Table title" />
        </div>
      </div>

      <div className="rounded border">
        <div className="grid grid-cols-[70px_1fr_50px_54px_64px_auto] gap-1 px-1 py-1 text-[9px] uppercase tracking-wide text-muted-foreground border-b">
          <span>Key</span><span>Header · Letter · Unit</span><span>Align</span><span>Format</span><span>Width</span><span></span>
        </div>
        {cols.map((c, i) => (
          <div key={i} className="grid grid-cols-[70px_1fr_50px_54px_64px_auto] gap-1 px-1 py-1 items-center border-b last:border-b-0">
            <Input className="h-7 text-[11px] font-mono" value={c.key ?? ""} onChange={(e) => patchCol(i, { ...c, key: e.target.value })} />
            <div className="flex gap-1">
              <ValueEditor value={c.header} onChange={(v) => patchCol(i, { ...c, header: v })} placeholder="Header" />
              <Input className="h-7 w-10 text-[11px] text-center" value={c.sub_header?.value ?? ""} onChange={(e) => patchCol(i, { ...c, sub_header: { kind: "literal", value: e.target.value } })} placeholder="A" />
              <Input className="h-7 w-12 text-[11px]" value={c.unit?.value ?? ""} onChange={(e) => patchCol(i, { ...c, unit: e.target.value ? { kind: "literal", value: e.target.value } : undefined })} placeholder="unit" />
            </div>
            <Select value={c.align ?? "right"} onValueChange={(a) => patchCol(i, { ...c, align: a })}>
              <SelectTrigger className="h-7 text-[10px] px-1"><SelectValue /></SelectTrigger>
              <SelectContent>{["left", "center", "right"].map((a) => <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={c.format ?? "number"} onValueChange={(f) => patchCol(i, { ...c, format: f })}>
              <SelectTrigger className="h-7 text-[10px] px-1"><SelectValue /></SelectTrigger>
              <SelectContent>{VALUE_FORMATS.map((f) => <SelectItem key={f} value={f} className="text-xs">{f}</SelectItem>)}</SelectContent>
            </Select>
            <Input className="h-7 text-[11px]" value={c.width ?? ""} onChange={(e) => { const val = e.target.value; patchCol(i, { ...c, width: val === "" ? undefined : (/^\d+$/.test(val) ? Number(val) : val) }); }} placeholder="auto" />
            <div className="flex">
              <Button size="sm" variant="ghost" className="h-6 w-5 p-0" onClick={() => moveCol(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-5 p-0" onClick={() => moveCol(i, 1)} disabled={i === cols.length - 1}><ArrowDown className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-5 p-0 text-destructive" onClick={() => removeCol(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
        ))}
        <div className="p-1"><Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={addCol}><Plus className="h-3 w-3 mr-1" />Add column</Button></div>
      </div>

      {/* Column groups */}
      <div className="rounded border p-2 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Column groups (span must total {cols.length} columns)</div>
        {groups.map((g, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input className="h-7 text-xs flex-1" value={g.label?.value ?? ""} onChange={(e) => { const c = [...groups]; c[i] = { ...g, label: { kind: "literal", value: e.target.value } }; set({ column_groups: c }); }} placeholder="Group label" />
            <Input type="number" className="h-7 w-16 text-xs" value={g.span ?? 1} onChange={(e) => { const c = [...groups]; c[i] = { ...g, span: Number(e.target.value) || 1 }; set({ column_groups: c }); }} />
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => set({ column_groups: groups.filter((_, idx) => idx !== i) })}><Trash2 className="h-3 w-3" /></Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => set({ column_groups: [...groups, { label: { kind: "literal", value: "" }, span: 1 }] })}><Plus className="h-3 w-3 mr-1" />Add group</Button>
          <span className="text-[10px] text-muted-foreground">Σ span = {groups.reduce((s, g) => s + (Number(g.span) || 0), 0)}</span>
        </div>
      </div>

      {/* Footer totals */}
      <div className="rounded border p-2 space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!footer} onChange={(e) => set({ footer: e.target.checked ? { label: { kind: "literal", value: "TOTAL" }, sum_columns: cols.filter((c) => c.format === "number" || c.format === "currency").map((c) => c.key) } : null })} />
          Show totals row
        </label>
        {footer && (
          <div className="flex flex-wrap gap-1 pt-1">
            {cols.map((c) => {
              const on = (footer.sum_columns ?? []).includes(c.key);
              return (
                <Button key={c.key} type="button" size="sm" variant={on ? "default" : "outline"} className="h-6 text-[10px] px-1.5"
                  onClick={() => {
                    const cur: string[] = footer.sum_columns ?? [];
                    const next = on ? cur.filter((x) => x !== c.key) : [...cur, c.key];
                    set({ footer: { ...footer, sum_columns: next } });
                  }}>
                  {c.key}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

interface Props {
  templateCode: string;
  body: V3Body;
  onChange: (next: V3Body) => void;
  onValidityChange?: (v: V3Validation) => void;
  /** Currently-selected node id from the WYSIWYG canvas. */
  selectedNodeId?: string | null;
  /** Fired when the publisher focuses a node card in the editor. */
  onSelectNode?: (nodeId: string) => void;
}

export function CertificateV3Editor({ templateCode, body, onChange, onValidityChange, selectedNodeId, onSelectNode }: Props) {
  const paper = body.paper_format;
  const patchPaper = (patch: Partial<PaperFormat>) => onChange({ ...body, paper_format: { ...paper, ...patch } });
  const pm = body.page_master ?? { code: `${templateCode.toLowerCase()}.page_master.v1`, header: [], footer: [] };

  const validation = useMemo(() => {
    const v = validateV3Body(body, []);
    onValidityChange?.(v);
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  const seedFromExample = () => onChange({
    schema_version: GENERIC_EXAMPLE_TEMPLATE.schema_version,
    code: templateCode,
    display_name: GENERIC_EXAMPLE_TEMPLATE.display_name,
    paper_format: { ...GENERIC_EXAMPLE_TEMPLATE.paper_format },
    page_master: JSON.parse(JSON.stringify(GENERIC_EXAMPLE_TEMPLATE.page_master)),
    document: JSON.parse(JSON.stringify(GENERIC_EXAMPLE_TEMPLATE.document)),
    theme: GENERIC_EXAMPLE_TEMPLATE.theme ? JSON.parse(JSON.stringify(GENERIC_EXAMPLE_TEMPLATE.theme)) : undefined,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm flex items-center gap-2"><FileCode2 className="h-4 w-4" /> Paper format</CardTitle>
          <Button type="button" size="sm" variant="outline" onClick={seedFromExample}>
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Seed from example template
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Size</Label>
            <Select value={paper.size} onValueChange={(v) => patchPaper({ size: v as PaperSize })}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>{["A4", "A3", "Letter", "Legal"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Orientation</Label>
            <Select value={paper.orientation} onValueChange={(v) => patchPaper({ orientation: v as Orientation })}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="portrait">Portrait</SelectItem>
                <SelectItem value="landscape">Landscape</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <MmField label="Margin top" value={paper.margin_top} onChange={(n) => patchPaper({ margin_top: n })} />
          <MmField label="Margin right" value={paper.margin_right} onChange={(n) => patchPaper({ margin_right: n })} />
          <MmField label="Margin bottom" value={paper.margin_bottom} onChange={(n) => patchPaper({ margin_bottom: n })} />
          <MmField label="Margin left" value={paper.margin_left} onChange={(n) => patchPaper({ margin_left: n })} />
          <MmField label="Header band" value={paper.header_height} onChange={(n) => patchPaper({ header_height: n })} />
          <MmField label="Footer band" value={paper.footer_height} onChange={(n) => patchPaper({ footer_height: n })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Page master (repeats on every page)</CardTitle></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Header band</Label>
            <NodeListEditor nodes={pm.header ?? []} allow={["heading", "rich_text", "image"]}
              onChange={(header) => onChange({ ...body, page_master: { ...pm, header } })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Footer band</Label>
            <NodeListEditor nodes={pm.footer ?? []} allow={["rich_text", "heading"]}
              onChange={(footer) => onChange({ ...body, page_master: { ...pm, footer } })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Document</CardTitle>
          <div className="flex flex-wrap gap-1">
            {[
              { key: "identity", label: "identity" },
              { key: "table", label: "table" },
              { key: "signature", label: "signature" },
            ].map((r) => {
              const present = r.key === "identity"
                ? validation.missing.every((m) => !m.startsWith("identity"))
                : r.key === "signature"
                  ? validation.missing.every((m) => !m.startsWith("signature"))
                  : validation.missing.every((m) => !m.startsWith("tabular"));
              return <Badge key={r.key} variant={present ? "outline" : "destructive"} className="text-[10px]">{present ? "✓" : "missing"} {r.label}</Badge>;
            })}
          </div>
        </CardHeader>
        <CardContent>
          <NodeListEditor
            nodes={body.document ?? []}
            onChange={(document) => onChange({ ...body, document })}
            scope="doc"
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
          />
        </CardContent>
      </Card>

      {!validation.ok && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Template is not saveable yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5 text-xs">
              {validation.missing.map((m) => <li key={m}>Missing: {m}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function MmField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label} (mm)</Label>
      <Input type="number" min={0} step={1} className="h-8"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => { const n = Number(e.target.value); onChange(Number.isFinite(n) ? n : 0); }} />
    </div>
  );
}
