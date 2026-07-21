/**
 * HardwareLabelTemplates — Phase 14 admin surface for `label_templates`.
 *
 * ADR-0087 · Template body owns CONTENT ONLY. Envelope (`^PW`/`^LL`,
 * `q`/`Q`, page dimensions) is injected at dispatch time from the
 * resolved media_profile so a single template body prints correctly on
 * 50×30, 80×50 or 102×152 mm at any DPI.
 *
 * The preview canvas uses `mmToCssPx` from `mediaGeometry.ts` — the SAME
 * module the driver + browser adapter use for their dot math — so what
 * the operator sees on-screen is proportionally identical to what a
 * hardware printer will emit. Prior to Phase 14, changing the "label
 * size" widget resized only the preview paper while the content stayed
 * pixel-fixed; the shared geometry service is what makes the two agree.
 *
 * Guardrail: `src/test/printing/label-templates-have-no-envelope.test.ts`
 * asserts that any body saved from this editor contains neither `^PW`
 * nor `q\d+` — the resolver would double-inject and produce a wrong
 * envelope on the second pass.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { mmToCssPx, mediaDots, DEFAULT_LABEL_DPI } from "@/services/printing/mediaGeometry";

type LabelEngine = "zpl" | "epl" | "escpos" | "pdf";

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
  body: string;
  is_default: boolean;
  active: boolean;
  media_profile_id: string | null;
}

const EMPTY_FORM: DraftForm = {
  template_key: "product_label",
  name: "",
  kind: "product",
  engine: "zpl",
  body: "",
  is_default: false,
  active: true,
  media_profile_id: null,
};

/** Regexes that catch envelope tokens baked into a template body. Must
 *  mirror the guardrail test so the editor rejects the same content the
 *  test would fail on. */
const ENVELOPE_PATTERNS: Array<{ engine: LabelEngine; regex: RegExp; label: string }> = [
  { engine: "zpl", regex: /\^PW\d+/i, label: "^PW (ZPL page width)" },
  { engine: "zpl", regex: /\^LL\d+/i, label: "^LL (ZPL label length)" },
  { engine: "epl", regex: /(^|\n)\s*q\d+/i, label: "q<dots> (EPL width)" },
  { engine: "epl", regex: /(^|\n)\s*Q\d+,\d+/i, label: "Q<dots>,<gap> (EPL length)" },
];

function detectEnvelope(engine: LabelEngine, body: string): string | null {
  for (const p of ENVELOPE_PATTERNS) {
    if (p.engine !== engine) continue;
    if (p.regex.test(body)) return p.label;
  }
  return null;
}

/** Preview render — draws the media rectangle to scale and paints a
 *  best-effort text pass of the template body for a proportional
 *  sanity-check. Not a full ZPL interpreter; goal is to confirm that
 *  changing the media size changes the paper AND the content ratio
 *  together (the exact defect the user reported). */
function LabelPreview({
  widthMm,
  heightMm,
  body,
  dpi,
}: {
  widthMm: number;
  heightMm: number | null;
  body: string;
  dpi: number;
}) {
  const h = heightMm ?? Math.max(20, widthMm * 0.6);
  // Cap preview to a sensible on-screen size — scale down uniformly so
  // huge shipping labels (102 × 152 mm) still fit in the dialog.
  const rawW = mmToCssPx(widthMm);
  const rawH = mmToCssPx(h);
  const maxW = 360;
  const maxH = 260;
  const scale = Math.min(1, maxW / rawW, maxH / rawH);
  const cssW = rawW * scale;
  const cssH = rawH * scale;
  const dots = mediaDots({ widthMm, heightMm: h, dpi });

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        Preview · {widthMm} × {heightMm ?? "cont."} mm at {dpi} dpi
        {" · "}
        {dots.widthDots} × {dots.heightDots ?? "—"} dots
      </div>
      <div
        className="relative border-2 border-dashed border-border bg-background shadow-sm"
        style={{ width: cssW, height: cssH }}
        aria-label="Label preview canvas"
      >
        <div
          className="absolute inset-0 overflow-hidden p-1 font-mono leading-tight"
          style={{ fontSize: 8 * scale, transform: `scale(${scale})`, transformOrigin: "top left", width: rawW, height: rawH }}
        >
          {body
            .replace(/\^XA|\^XZ|\^FS/g, "")
            .split(/\^FO\d+,\d+/)
            .map((chunk, i) => {
              const text = chunk.match(/\^FD([^^]+)/)?.[1] ?? chunk.match(/\^BCN[^^]*\^FD([^^]+)/)?.[1];
              if (!text) return null;
              return (
                <div key={i} className="truncate">
                  {text.trim()}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

export default function HardwareLabelTemplates() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const [rows, setRows] = useState<LabelTemplate[]>([]);
  const [media, setMedia] = useState<MediaProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DraftForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const [tpls, mps] = await Promise.all([
      supabase
        .from("label_templates")
        .select("id, org_id, template_key, name, kind, engine, body, version, is_default, active, branch_id, media_profile_id, updated_at")
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
    if (editing.media_profile_id) {
      return media.find((m) => m.id === editing.media_profile_id) ?? null;
    }
    return media.find((m) => m.kind === "label") ?? media[0] ?? null;
  }, [editing, media]);

  const envelopeWarning = editing ? detectEnvelope(editing.engine, editing.body) : null;

  function startCreate() { setEditing({ ...EMPTY_FORM }); }
  function startEdit(row: LabelTemplate) {
    setEditing({
      id: row.id,
      template_key: row.template_key,
      name: row.name,
      kind: row.kind,
      engine: row.engine,
      body: row.body,
      is_default: row.is_default,
      active: row.active,
      media_profile_id: row.media_profile_id,
    });
  }

  async function save() {
    if (!editing || !orgId) return;
    if (!editing.name.trim() || !editing.template_key.trim()) {
      toast.error("Template key and name are required.");
      return;
    }
    if (!editing.body.trim()) {
      toast.error("Template body cannot be empty.");
      return;
    }
    const envelope = detectEnvelope(editing.engine, editing.body);
    if (envelope) {
      toast.error(
        `Envelope token detected: ${envelope}. Templates own content only — remove it and the resolver injects it from the media profile.`,
      );
      return;
    }

    setSaving(true);
    const payload = {
      org_id: orgId,
      template_key: editing.template_key.trim(),
      name: editing.name.trim(),
      kind: editing.kind,
      engine: editing.engine,
      body: editing.body,
      is_default: editing.is_default,
      active: editing.active,
      media_profile_id: editing.media_profile_id,
      // width/height on label_templates are legacy; media_profile owns geometry.
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
    if (!confirm(`Delete template "${row.name}"? Devices resolving this template will fall back to the next-lower rank.`)) return;
    const { error } = await supabase.from("label_templates").delete().eq("id", row.id);
    if (error) return void toast.error(`Delete failed: ${error.message}`);
    toast.success("Template deleted.");
    void load();
  }

  const templateKeys = Array.from(grouped.keys()).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Label templates</h1>
          <p className="text-sm text-muted-foreground">
            Template body owns content only. The dispatcher injects paper envelope
            (`^PW`/`^LL`, `q`/`Q`) from the resolved media profile at print time.
            See ADR-0087.
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
          <Skeleton className="h-10 w-full" />
        </div>
      ) : templateKeys.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No templates yet</CardTitle>
            <CardDescription>
              Create your first label template. Leave the media pin blank to have it
              resolve for every media size in your organization.
            </CardDescription>
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
                  {list.length} version{list.length === 1 ? "" : "s"} · resolver picks highest active version per rank.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Engine</TableHead>
                      <TableHead>Media pin</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Flags</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((r) => {
                      const mp = r.media_profile_id ? media.find((m) => m.id === r.media_profile_id) : null;
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell className="uppercase text-xs">{r.engine}</TableCell>
                          <TableCell className="text-xs">
                            {mp ? `${mp.code} · ${mp.width_mm}×${mp.height_mm ?? "cont."} mm` : (
                              <span className="text-muted-foreground">Any (media-agnostic)</span>
                            )}
                          </TableCell>
                          <TableCell>v{r.version}</TableCell>
                          <TableCell className="space-x-1">
                            {r.is_default && <Badge variant="secondary">default</Badge>}
                            {!r.active && <Badge variant="outline">inactive</Badge>}
                            {r.branch_id && <Badge variant="outline">branch</Badge>}
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
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit label template" : "New label template"}</DialogTitle>
            <DialogDescription>
              Content only — no `^PW`, `^LL`, `q<dots>` or `Q<dots>,<gap>`. The
              dispatcher injects the envelope from the resolved media profile.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4 py-2 md:grid-cols-[1fr,auto]">
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
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
                    <Label htmlFor="tpl-kind">Kind</Label>
                    <Input
                      id="tpl-kind"
                      value={editing.kind}
                      onChange={(e) => setEditing({ ...editing, kind: e.target.value })}
                      placeholder="product"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="tpl-name">Name</Label>
                  <Input
                    id="tpl-name"
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="Default product label"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="tpl-engine">Engine</Label>
                    <Select
                      value={editing.engine}
                      onValueChange={(v) => setEditing({ ...editing, engine: v as LabelEngine })}
                    >
                      <SelectTrigger id="tpl-engine"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="zpl">ZPL (Zebra)</SelectItem>
                        <SelectItem value="epl">EPL2 (Zebra legacy)</SelectItem>
                        <SelectItem value="escpos">ESC/POS</SelectItem>
                        <SelectItem value="pdf">PDF</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="tpl-media">Media pin</Label>
                    <Select
                      value={editing.media_profile_id ?? "__any__"}
                      onValueChange={(v) => setEditing({ ...editing, media_profile_id: v === "__any__" ? null : v })}
                    >
                      <SelectTrigger id="tpl-media"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__any__">Any (media-agnostic)</SelectItem>
                        {media.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.code} · {m.width_mm}×{m.height_mm ?? "cont."} mm
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label htmlFor="tpl-body">Body</Label>
                  <Textarea
                    id="tpl-body"
                    value={editing.body}
                    onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                    className="font-mono text-xs h-56"
                    placeholder={"^XA\n^CF0,28^FO20,20^FD{{name}}^FS\n^BY2,2,80^FO20,100^BCN,80,Y,N,N^FD{{barcode}}^FS\n^XZ"}
                  />
                  {envelopeWarning && (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                      <div>
                        Envelope token detected: <strong>{envelopeWarning}</strong>.
                        Remove it — the dispatcher injects the envelope from the resolved
                        media profile at print time. Leaving it here causes double-injection.
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editing.is_default}
                      onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
                    />
                    Default for this key
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editing.active}
                      onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                    />
                    Active
                  </label>
                </div>
              </div>
              <div>
                {previewMedia ? (
                  <LabelPreview
                    widthMm={previewMedia.width_mm}
                    heightMm={previewMedia.height_mm}
                    body={editing.body}
                    dpi={DEFAULT_LABEL_DPI}
                  />
                ) : (
                  <div className="text-xs text-muted-foreground">
                    No media profiles found — add one in <em>Media profiles</em> to see the preview.
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !!envelopeWarning}>
              {saving ? "Saving…" : editing?.id ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
