/**
 * HardwareLabelTemplates — ADR-0090 · Visual Label Designer.
 *
 * The editor never asks operators to type ZPL / EPL. Templates are
 * authored as a structured document (list of positioned elements in
 * millimeters) and saved to `label_templates.body_json`. At print time
 * `labelDispatch` compiles that document into engine-native bytes
 * (ZPL / EPL / ESC-POS) using media geometry from `mediaGeometry.ts`.
 *
 * The legacy `body` column is kept in sync with a compiled snapshot so
 * older readers (audit exports, drivers that inspect it) still see a
 * meaningful string — but the dispatcher prefers `body_json` whenever
 * present. ADR-0087 still holds: the compiler emits CONTENT ONLY; the
 * dispatcher owns the paper envelope.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Pencil, Trash2, Type, Hash, Barcode, Minus, Square, MoveUp, MoveDown,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { DEFAULT_LABEL_DPI } from "@/services/printing/mediaGeometry";
import {
  compileLabelDoc, isLabelDoc, EMPTY_DOC,
  type LabelDoc, type LabelElement, type LabelEngine,
} from "@/services/printing/labelCompiler";

interface MediaProfile {
  id: string;
  code: string;
  name: string;
  width_mm: number;
  height_mm: number | null;
  kind: string;
}

interface LabelTemplate {
  id: string;
  org_id: string;
  template_key: string;
  name: string;
  kind: string;
  engine: LabelEngine;
  body: string;
  body_json: unknown;
  version: number;
  is_default: boolean;
  active: boolean;
  branch_id: string | null;
  media_profile_id: string | null;
  updated_at: string;
}

interface DraftForm {
  id?: string;
  template_key: string;
  name: string;
  kind: string;
  engine: LabelEngine;
  doc: LabelDoc;
  is_default: boolean;
  active: boolean;
  media_profile_id: string | null;
}

const EMPTY_FORM: DraftForm = {
  template_key: "product_label",
  name: "",
  kind: "product",
  engine: "zpl",
  doc: EMPTY_DOC,
  is_default: false,
  active: true,
  media_profile_id: null,
};

/** Common variable tokens exposed in the picker. Callers already pass
 *  these into vars; the operator picks from a list instead of typing
 *  `{{token}}` by hand. */
const VARIABLE_CATALOG: Array<{ token: string; label: string; group: string }> = [
  { token: "name", label: "Product name", group: "Product" },
  { token: "sku", label: "SKU", group: "Product" },
  { token: "sku_display", label: "SKU (display)", group: "Product" },
  { token: "barcode", label: "Barcode / EAN", group: "Product" },
  { token: "price_display", label: "Price", group: "Product" },
  { token: "lot_number", label: "Lot number", group: "Traceability" },
  { token: "expiry_date", label: "Expiry date", group: "Traceability" },
  { token: "manufacture_date", label: "Manufacture date", group: "Traceability" },
  { token: "grn_id", label: "GRN number", group: "Warehouse" },
  { token: "supplier_name", label: "Supplier", group: "Warehouse" },
  { token: "bin_code", label: "Bin location", group: "Warehouse" },
  { token: "lpn", label: "License plate (LPN)", group: "Warehouse" },
  { token: "carton_id", label: "Carton ID", group: "Warehouse" },
  { token: "order_number", label: "Order number", group: "Shipping" },
  { token: "customer_name", label: "Customer", group: "Shipping" },
  { token: "ship_to_address", label: "Ship-to address", group: "Shipping" },
];

const uid = () => Math.random().toString(36).slice(2, 10);

/** Coerce whatever came back from the DB into a LabelDoc, so both
 *  legacy raw-body rows and modernized rows land in the same editor. */
function toDoc(row: LabelTemplate): LabelDoc {
  if (isLabelDoc(row.body_json)) return row.body_json as LabelDoc;
  return EMPTY_DOC;
}

// ------------------------------------------------------------------
// Canvas — SVG rendering of the LabelDoc + drag handling
// ------------------------------------------------------------------

interface CanvasProps {
  doc: LabelDoc;
  widthMm: number;
  heightMm: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (doc: LabelDoc) => void;
}

function LabelCanvas({ doc, widthMm, heightMm, selectedId, onSelect, onChange }: CanvasProps) {
  const PX_PER_MM = 4; // preview scale (screen only; does not affect print)
  const cssW = widthMm * PX_PER_MM;
  const cssH = heightMm * PX_PER_MM;

  const [drag, setDrag] = useState<{ id: string; offsetXmm: number; offsetYmm: number } | null>(null);

  const pointerToMm = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    return {
      xMm: ((e.clientX - rect.left) / rect.width) * widthMm,
      yMm: ((e.clientY - rect.top) / rect.height) * heightMm,
    };
  };

  const startDrag = (e: React.PointerEvent, el: LabelElement) => {
    e.stopPropagation();
    onSelect(el.id);
    const { xMm, yMm } = pointerToMm(e as unknown as React.PointerEvent<SVGSVGElement>);
    setDrag({ id: el.id, offsetXmm: xMm - el.xMm, offsetYmm: yMm - el.yMm });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const { xMm, yMm } = pointerToMm(e);
    onChange({
      ...doc,
      elements: doc.elements.map((el) =>
        el.id === drag.id
          ? {
              ...el,
              xMm: Math.max(0, Math.min(widthMm - 2, +(xMm - drag.offsetXmm).toFixed(2))),
              yMm: Math.max(0, Math.min(heightMm - 2, +(yMm - drag.offsetYmm).toFixed(2))),
            }
          : el,
      ),
    });
  };

  const endDrag = () => setDrag(null);

  return (
    <div className="inline-block rounded-md border-2 border-dashed border-border bg-background shadow-sm">
      <svg
        width={cssW}
        height={cssH}
        viewBox={`0 0 ${widthMm} ${heightMm}`}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onClick={() => onSelect(null)}
        style={{ touchAction: "none" }}
        aria-label="Label design canvas"
      >
        {/* Millimeter guide grid */}
        <defs>
          <pattern id="mm-grid" width="5" height="5" patternUnits="userSpaceOnUse">
            <path d="M 5 0 L 0 0 0 5" fill="none" stroke="hsl(var(--muted-foreground) / 0.15)" strokeWidth="0.1" />
          </pattern>
        </defs>
        <rect width={widthMm} height={heightMm} fill="url(#mm-grid)" />

        {doc.elements.map((el) => {
          const sel = el.id === selectedId;
          const stroke = sel ? "hsl(var(--primary))" : "hsl(var(--foreground) / 0.4)";
          const common = {
            onPointerDown: (e: React.PointerEvent) => startDrag(e, el),
            style: { cursor: "move" as const },
          };
          switch (el.type) {
            case "text":
            case "variable": {
              const label = el.type === "text" ? el.text : `{{${el.token}}}`;
              const size = (el.fontSize ?? 4) * 0.9;
              return (
                <g key={el.id} {...common}>
                  <text
                    x={el.xMm}
                    y={el.yMm + size * 0.9}
                    fontSize={size}
                    fontWeight={el.bold ? 700 : 400}
                    fill="hsl(var(--foreground))"
                    fontFamily="ui-sans-serif, system-ui"
                  >
                    {label}
                  </text>
                  {sel && (
                    <rect
                      x={el.xMm - 0.4}
                      y={el.yMm - 0.4}
                      width={Math.max(10, label.length * size * 0.55) + 0.8}
                      height={size * 1.3}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={0.2}
                      strokeDasharray="0.6 0.4"
                    />
                  )}
                </g>
              );
            }
            case "barcode": {
              const h = el.heightMm ?? 12;
              const w = el.symbology === "qr" ? h : Math.max(20, h * 2);
              return (
                <g key={el.id} {...common}>
                  <rect x={el.xMm} y={el.yMm} width={w} height={h} fill="hsl(var(--foreground) / 0.08)" stroke={stroke} strokeWidth={0.2} />
                  {/* Fake bar stripes for the preview */}
                  {el.symbology !== "qr" && Array.from({ length: 24 }).map((_, i) => (
                    <rect
                      key={i}
                      x={el.xMm + 0.5 + i * (w - 1) / 24}
                      y={el.yMm + 0.5}
                      width={(w - 1) / 48}
                      height={h - 1}
                      fill="hsl(var(--foreground))"
                    />
                  ))}
                  <text x={el.xMm + w / 2} y={el.yMm + h + 2.2} fontSize={1.8} textAnchor="middle" fill="hsl(var(--muted-foreground))">
                    {el.symbology.toUpperCase()} · {el.token}
                  </text>
                </g>
              );
            }
            case "line":
            case "box": {
              const t = el.type === "box" ? (el.thicknessMm ?? 0.4) : Math.min(el.wMm, el.hMm);
              return (
                <g key={el.id} {...common}>
                  <rect
                    x={el.xMm}
                    y={el.yMm}
                    width={el.wMm}
                    height={el.hMm}
                    fill={el.type === "line" ? "hsl(var(--foreground))" : "none"}
                    stroke={sel ? stroke : "hsl(var(--foreground))"}
                    strokeWidth={t}
                  />
                </g>
              );
            }
          }
        })}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------

export default function HardwareLabelTemplates() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const [rows, setRows] = useState<LabelTemplate[]>([]);
  const [media, setMedia] = useState<MediaProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DraftForm | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const [tpls, mps] = await Promise.all([
      supabase
        .from("label_templates")
        .select("id, org_id, template_key, name, kind, engine, body, body_json, version, is_default, active, branch_id, media_profile_id, updated_at")
        .eq("org_id", orgId)
        .order("template_key", { ascending: true })
        .order("version", { ascending: false }),
      supabase
        .from("media_profiles")
        .select("id, code, name, width_mm, height_mm, kind")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("kind", { ascending: true })
        .order("width_mm", { ascending: true }),
    ]);
    setLoading(false);
    if (tpls.error) toast.error(`Load templates failed: ${tpls.error.message}`);
    if (mps.error) toast.error(`Load media failed: ${mps.error.message}`);
    setRows((tpls.data as LabelTemplate[] | null) ?? []);
    setMedia((mps.data as MediaProfile[] | null) ?? []);
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const grouped = useMemo(() => {
    const by = new Map<string, LabelTemplate[]>();
    for (const r of rows) {
      const key = r.template_key;
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(r);
    }
    return by;
  }, [rows]);

  const previewMedia = useMemo(() => {
    if (!editing) return null;
    if (editing.media_profile_id) return media.find((m) => m.id === editing.media_profile_id) ?? null;
    return media.find((m) => m.kind === "label") ?? media[0] ?? null;
  }, [editing, media]);

  function startCreate() {
    setEditing({ ...EMPTY_FORM, doc: { version: 1, elements: [] } });
    setSelectedId(null);
  }

  function startEdit(row: LabelTemplate) {
    setEditing({
      id: row.id,
      template_key: row.template_key,
      name: row.name,
      kind: row.kind,
      engine: row.engine,
      doc: toDoc(row),
      is_default: row.is_default,
      active: row.active,
      media_profile_id: row.media_profile_id,
    });
    setSelectedId(null);
  }

  const updateDoc = (mut: (d: LabelDoc) => LabelDoc) => {
    setEditing((prev) => (prev ? { ...prev, doc: mut(prev.doc) } : prev));
  };

  const addElement = (el: LabelElement) => {
    updateDoc((d) => ({ ...d, elements: [...d.elements, el] }));
    setSelectedId(el.id);
  };

  const patchElement = (id: string, patch: Partial<LabelElement>) => {
    updateDoc((d) => ({
      ...d,
      elements: d.elements.map((e) => (e.id === id ? { ...e, ...patch } as LabelElement : e)),
    }));
  };

  const removeElement = (id: string) => {
    updateDoc((d) => ({ ...d, elements: d.elements.filter((e) => e.id !== id) }));
    setSelectedId(null);
  };

  const moveElement = (id: string, dir: -1 | 1) => {
    updateDoc((d) => {
      const idx = d.elements.findIndex((e) => e.id === id);
      if (idx < 0) return d;
      const to = Math.max(0, Math.min(d.elements.length - 1, idx + dir));
      if (to === idx) return d;
      const next = d.elements.slice();
      const [item] = next.splice(idx, 1);
      next.splice(to, 0, item);
      return { ...d, elements: next };
    });
  };

  async function save() {
    if (!editing || !orgId) return;
    if (!editing.name.trim() || !editing.template_key.trim()) {
      toast.error("Template key and name are required.");
      return;
    }
    if (editing.doc.elements.length === 0) {
      toast.error("Add at least one element to the label.");
      return;
    }

    setSaving(true);
    // Compile a legacy body snapshot so downstream readers that still
    // read `body` (audit exports, older drivers) get a coherent value.
    // The dispatcher prefers body_json when present (ADR-0090).
    const compiledBody = compileLabelDoc(editing.doc, editing.engine, DEFAULT_LABEL_DPI);
    const payload = {
      org_id: orgId,
      template_key: editing.template_key.trim(),
      name: editing.name.trim(),
      kind: editing.kind,
      engine: editing.engine,
      body: compiledBody,
      body_json: editing.doc as unknown as never,
      is_default: editing.is_default,
      active: editing.active,
      media_profile_id: editing.media_profile_id,
      width_mm: null,
      height_mm: null,
    };
    const q = editing.id
      ? supabase.from("label_templates").update(payload).eq("id", editing.id)
      : supabase.from("label_templates").insert({ ...payload, version: 1 });
    const { error } = await q;
    setSaving(false);
    if (error) {
      toast.error(`Save failed: ${error.message}`);
      return;
    }
    toast.success(editing.id ? "Template updated." : "Template created.");
    setEditing(null);
    void load();
  }

  async function remove(row: LabelTemplate) {
    if (!confirm(`Delete template "${row.name}"?`)) return;
    const { error } = await supabase.from("label_templates").delete().eq("id", row.id);
    if (error) return void toast.error(`Delete failed: ${error.message}`);
    toast.success("Template deleted.");
    void load();
  }

  const templateKeys = Array.from(grouped.keys()).sort();
  const selected = editing?.doc.elements.find((e) => e.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Label templates</h1>
          <p className="text-sm text-muted-foreground">
            Design labels visually — no printer code to type. The system compiles the layout
            to ZPL, EPL, or ESC-POS for the chosen printer at print time.
          </p>
        </div>
        <Button onClick={startCreate}>
          <Plus className="mr-2 h-4 w-4" /> New template
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : templateKeys.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No templates yet</CardTitle>
            <CardDescription>Create your first label — click <em>New template</em>.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        templateKeys.map((key) => {
          const list = grouped.get(key)!;
          return (
            <Card key={key}>
              <CardHeader>
                <CardTitle className="font-mono text-sm">{key}</CardTitle>
                <CardDescription>
                  {list.length} version{list.length === 1 ? "" : "s"} · resolver picks the best match per print job.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Engine</TableHead>
                      <TableHead>Media</TableHead>
                      <TableHead>Editor</TableHead>
                      <TableHead>Flags</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((r) => {
                      const mp = r.media_profile_id ? media.find((m) => m.id === r.media_profile_id) : null;
                      const isModern = isLabelDoc(r.body_json);
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell className="uppercase text-xs">{r.engine}</TableCell>
                          <TableCell className="text-xs">
                            {mp ? `${mp.code} · ${mp.width_mm}×${mp.height_mm ?? "cont."} mm` : (
                              <span className="text-muted-foreground">Any</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {isModern
                              ? <Badge variant="secondary">Visual</Badge>
                              : <Badge variant="outline">Legacy</Badge>}
                          </TableCell>
                          <TableCell className="space-x-1">
                            {r.is_default && <Badge variant="secondary">default</Badge>}
                            {!r.active && <Badge variant="outline">inactive</Badge>}
                          </TableCell>
                          <TableCell className="text-right space-x-2">
                            <Button variant="ghost" size="sm" onClick={() => startEdit(r)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => remove(r)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })
      )}

      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-6xl max-h-[95vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit label template" : "New label template"}</DialogTitle>
            <DialogDescription>
              Drag elements on the canvas. Insert variables from the picker — the system fills them
              in from the print context (product, GRN, lot, order, …).
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="grid gap-4 md:grid-cols-[220px,1fr,260px]">
              {/* Left: toolbox + metadata */}
              <div className="space-y-3">
                <div>
                  <Label htmlFor="tpl-name">Name</Label>
                  <Input
                    id="tpl-name"
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="Default product label"
                  />
                </div>
                <div>
                  <Label htmlFor="tpl-key">Template key</Label>
                  <Input
                    id="tpl-key"
                    value={editing.template_key}
                    onChange={(e) => setEditing({ ...editing, template_key: e.target.value })}
                    placeholder="product_label"
                  />
                </div>
                <div>
                  <Label>Printer engine</Label>
                  <Select
                    value={editing.engine}
                    onValueChange={(v) => setEditing({ ...editing, engine: v as LabelEngine })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zpl">Zebra ZPL</SelectItem>
                      <SelectItem value="epl">Zebra EPL2</SelectItem>
                      <SelectItem value="escpos">ESC/POS</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Paper size</Label>
                  <Select
                    value={editing.media_profile_id ?? "__any__"}
                    onValueChange={(v) => setEditing({ ...editing, media_profile_id: v === "__any__" ? null : v })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__any__">Any media</SelectItem>
                      {media.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.code} · {m.width_mm}×{m.height_mm ?? "cont."} mm
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="pt-2 border-t">
                  <div className="text-xs font-medium text-muted-foreground mb-2">Add element</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => addElement({ id: uid(), type: "text", xMm: 4, yMm: 4, text: "Text", fontSize: 4 })}>
                      <Type className="h-3.5 w-3.5 mr-1" /> Text
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => addElement({ id: uid(), type: "variable", xMm: 4, yMm: 10, token: "name", fontSize: 4 })}>
                      <Hash className="h-3.5 w-3.5 mr-1" /> Variable
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => addElement({ id: uid(), type: "barcode", xMm: 4, yMm: 18, token: "barcode", symbology: "code128", heightMm: 10 })}>
                      <Barcode className="h-3.5 w-3.5 mr-1" /> Barcode
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => addElement({ id: uid(), type: "line", xMm: 4, yMm: 32, wMm: 30, hMm: 0.4 })}>
                      <Minus className="h-3.5 w-3.5 mr-1" /> Line
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => addElement({ id: uid(), type: "box", xMm: 4, yMm: 34, wMm: 20, hMm: 10, thicknessMm: 0.4 })}>
                      <Square className="h-3.5 w-3.5 mr-1" /> Box
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-4 pt-2 border-t">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={editing.is_default} onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })} />
                    Default
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                    Active
                  </label>
                </div>
              </div>

              {/* Center: canvas */}
              <div className="flex flex-col items-center gap-2">
                {previewMedia ? (
                  <>
                    <div className="text-xs text-muted-foreground">
                      {previewMedia.width_mm} × {previewMedia.height_mm ?? 40} mm · drag elements to reposition
                    </div>
                    <LabelCanvas
                      doc={editing.doc}
                      widthMm={previewMedia.width_mm}
                      heightMm={previewMedia.height_mm ?? 40}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      onChange={(d) => setEditing({ ...editing, doc: d })}
                    />
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    No media profiles found — add one in <em>Media profiles</em> to see the canvas.
                  </div>
                )}
              </div>

              {/* Right: property inspector */}
              <div className="space-y-3">
                {!selected && (
                  <div className="text-xs text-muted-foreground">
                    Select an element on the canvas to edit its properties.
                  </div>
                )}
                {selected && (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium capitalize">{selected.type}</div>
                      <div className="flex gap-1">
                        <Button size="icon" variant="ghost" onClick={() => moveElement(selected.id, -1)} aria-label="Move up">
                          <MoveUp className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => moveElement(selected.id, 1)} aria-label="Move down">
                          <MoveDown className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => removeElement(selected.id)} aria-label="Delete">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">X (mm)</Label>
                        <Input
                          type="number" step={0.5}
                          value={selected.xMm}
                          onChange={(e) => patchElement(selected.id, { xMm: Number(e.target.value) } as Partial<LabelElement>)}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Y (mm)</Label>
                        <Input
                          type="number" step={0.5}
                          value={selected.yMm}
                          onChange={(e) => patchElement(selected.id, { yMm: Number(e.target.value) } as Partial<LabelElement>)}
                        />
                      </div>
                    </div>

                    {selected.type === "text" && (
                      <div>
                        <Label className="text-xs">Text</Label>
                        <Input
                          value={selected.text}
                          onChange={(e) => patchElement(selected.id, { text: e.target.value } as Partial<LabelElement>)}
                        />
                      </div>
                    )}

                    {selected.type === "variable" && (
                      <div>
                        <Label className="text-xs">Variable</Label>
                        <Select
                          value={selected.token}
                          onValueChange={(v) => patchElement(selected.id, { token: v } as Partial<LabelElement>)}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {VARIABLE_CATALOG.map((v) => (
                              <SelectItem key={v.token} value={v.token}>
                                {v.label} <span className="text-muted-foreground">· {v.group}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {(selected.type === "text" || selected.type === "variable") && (
                      <>
                        <div>
                          <Label className="text-xs">Font size (1–10)</Label>
                          <Input
                            type="number" min={1} max={10}
                            value={selected.fontSize ?? 4}
                            onChange={(e) => patchElement(selected.id, { fontSize: Math.max(1, Math.min(10, Number(e.target.value))) } as Partial<LabelElement>)}
                          />
                        </div>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!selected.bold}
                            onChange={(e) => patchElement(selected.id, { bold: e.target.checked } as Partial<LabelElement>)}
                          />
                          Bold
                        </label>
                      </>
                    )}

                    {selected.type === "barcode" && (
                      <>
                        <div>
                          <Label className="text-xs">Symbology</Label>
                          <Select
                            value={selected.symbology}
                            onValueChange={(v) => patchElement(selected.id, { symbology: v as "code128" | "ean13" | "qr" } as Partial<LabelElement>)}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="code128">Code 128</SelectItem>
                              <SelectItem value="ean13">EAN-13</SelectItem>
                              <SelectItem value="qr">QR Code</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-xs">Data source</Label>
                          <Select
                            value={selected.token}
                            onValueChange={(v) => patchElement(selected.id, { token: v } as Partial<LabelElement>)}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {VARIABLE_CATALOG.map((v) => (
                                <SelectItem key={v.token} value={v.token}>{v.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-xs">Height (mm)</Label>
                          <Input
                            type="number" step={0.5}
                            value={selected.heightMm ?? 12}
                            onChange={(e) => patchElement(selected.id, { heightMm: Number(e.target.value) } as Partial<LabelElement>)}
                          />
                        </div>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!selected.hri}
                            onChange={(e) => patchElement(selected.id, { hri: e.target.checked } as Partial<LabelElement>)}
                          />
                          Show human-readable digits
                        </label>
                      </>
                    )}

                    {(selected.type === "line" || selected.type === "box") && (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">Width (mm)</Label>
                            <Input
                              type="number" step={0.5}
                              value={selected.wMm}
                              onChange={(e) => patchElement(selected.id, { wMm: Number(e.target.value) } as Partial<LabelElement>)}
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Height (mm)</Label>
                            <Input
                              type="number" step={0.5}
                              value={selected.hMm}
                              onChange={(e) => patchElement(selected.id, { hMm: Number(e.target.value) } as Partial<LabelElement>)}
                            />
                          </div>
                        </div>
                        {selected.type === "box" && (
                          <div>
                            <Label className="text-xs">Border thickness (mm)</Label>
                            <Input
                              type="number" step={0.1}
                              value={selected.thicknessMm ?? 0.4}
                              onChange={(e) => patchElement(selected.id, { thicknessMm: Number(e.target.value) } as Partial<LabelElement>)}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : editing?.id ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
