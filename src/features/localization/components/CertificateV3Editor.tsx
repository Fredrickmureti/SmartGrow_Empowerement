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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertTriangle, FileCode2, Sparkles, Plus, Trash2, ArrowUp, ArrowDown, Link2, Type,
} from "lucide-react";
import { KE_P9_V3_TEMPLATE } from "../lib/engine/templates/keP9";

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
  schema_version: 3;
  code?: string;
  display_name?: string;
  paper_format: PaperFormat;
  page_master?: { code?: string; header?: any[]; footer?: any[] };
  document: any[];
}

type Value = { kind: "literal"; value: string | number } | { kind: "binding"; path: string; format?: string; fallback?: string };

const VALUE_FORMATS = ["text", "number", "currency", "percent", "date", "month_short"];
const NODE_TYPES = [
  { value: "heading", label: "Heading" },
  { value: "rich_text", label: "Rich text / paragraph" },
  { value: "key_value", label: "Key / value" },
  { value: "identity_strip", label: "Identity strip (two columns)" },
  { value: "matrix", label: "Matrix (table)" },
  { value: "legal_notice", label: "Legal notice" },
  { value: "signature_strip", label: "Signature strip" },
  { value: "section", label: "Section (group)" },
  { value: "spacer", label: "Spacer" },
];

export function defaultV3Body(templateCode: string): V3Body {
  return {
    schema_version: 3,
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

// ── Validation (mirror of DB validators) ─────────────────────────────────

export interface V3Validation {
  ok: boolean;
  missing: string[];
  parseErrors: string[];
}

export function validateV3Body(body: Partial<V3Body>, parseErrors: string[] = []): V3Validation {
  const missing: string[] = [];
  if (!body.paper_format) missing.push("paper_format");
  const doc = Array.isArray(body.document) ? body.document : [];
  if (doc.length === 0) missing.push("non-empty document");
  const hasType = (t: string) => doc.some((n: any) => n && typeof n === "object" && n.type === t);
  if (!hasType("identity_strip")) missing.push("identity_strip node");
  if (!hasType("signature_strip")) missing.push("signature_strip node");
  if (!hasType("matrix")) missing.push("matrix node");
  return { ok: missing.length === 0 && parseErrors.length === 0, missing, parseErrors };
}

// ── Value editor ─────────────────────────────────────────────────────────

function ValueEditor({ value, onChange, placeholder }: {
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
          <Input
            className="h-7 text-xs font-mono"
            placeholder="payload.path e.g. employer.name"
            value={(v as any).path ?? ""}
            onChange={(e) => onChange({ ...v, kind: "binding", path: e.target.value } as Value)}
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
        <Input
          className="h-7 text-xs"
          placeholder={placeholder ?? "Static text"}
          value={String((v as any).value ?? "")}
          onChange={(e) => onChange({ kind: "literal", value: e.target.value })}
        />
      )}
    </div>
  );
}

// ── Node list editor (used for document, page header/footer, section) ─────

function NodeListEditor({ nodes, onChange, allow }: {
  nodes: any[];
  onChange: (next: any[]) => void;
  allow?: string[];
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
      {(nodes ?? []).map((n, i) => (
        <div key={i} className="rounded-md border p-2 space-y-2 bg-card">
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
      ))}
      <Select onValueChange={add}>
        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="+ Add node…" /></SelectTrigger>
        <SelectContent>
          {types.map((t) => <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function newNode(type: string): any {
  switch (type) {
    case "heading": return { type: "heading", level: 2, align: "left", text: { kind: "literal", value: "Heading" } };
    case "rich_text": return { type: "rich_text", align: "left", paragraphs: [[{ text: { kind: "literal", value: "Text" } }]] };
    case "key_value": return { type: "key_value", label: { kind: "literal", value: "Label" }, value: { kind: "binding", path: "" } };
    case "identity_strip": return { type: "identity_strip", left_title: { kind: "literal", value: "Left" }, right_title: { kind: "literal", value: "Right" }, left: [], right: [] };
    case "matrix": return { type: "matrix", title: { kind: "literal", value: "Table" }, rows_binding: "", repeat_header: true, columns: [], column_groups: [], footer: null };
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
          <Textarea
            className="text-xs" rows={2}
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
          <Textarea
            className="text-xs" rows={3}
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
    default:
      return <div className="text-[11px] text-muted-foreground">No editor for “{node.type}”.</div>;
  }
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
          <Input className="h-7 text-xs font-mono" value={node.rows_binding ?? ""} onChange={(e) => set({ rows_binding: e.target.value })} placeholder="e.g. p9.months" />
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
}

export function CertificateV3Editor({ templateCode, body, onChange, onValidityChange }: Props) {
  const paper = body.paper_format;
  const patchPaper = (patch: Partial<PaperFormat>) => onChange({ ...body, paper_format: { ...paper, ...patch } });
  const pm = body.page_master ?? { code: `${templateCode.toLowerCase()}.page_master.v1`, header: [], footer: [] };

  const validation = useMemo(() => {
    const v = validateV3Body(body, []);
    onValidityChange?.(v);
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  const seedFromKeP9 = () => onChange({
    schema_version: 3,
    code: templateCode,
    display_name: KE_P9_V3_TEMPLATE.display_name,
    paper_format: { ...KE_P9_V3_TEMPLATE.paper_format },
    page_master: JSON.parse(JSON.stringify(KE_P9_V3_TEMPLATE.page_master)),
    document: JSON.parse(JSON.stringify(KE_P9_V3_TEMPLATE.document)),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm flex items-center gap-2"><FileCode2 className="h-4 w-4" /> Paper format</CardTitle>
          <Button type="button" size="sm" variant="outline" onClick={seedFromKeP9}>
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Seed from Kenya P9
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
            {["identity_strip", "matrix", "signature_strip"].map((t) => {
              const present = Array.isArray(body.document) && body.document.some((n: any) => n?.type === t);
              return <Badge key={t} variant={present ? "outline" : "destructive"} className="text-[10px]">{present ? "✓" : "missing"} {t}</Badge>;
            })}
          </div>
        </CardHeader>
        <CardContent>
          <NodeListEditor nodes={body.document ?? []} onChange={(document) => onChange({ ...body, document })} />
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
