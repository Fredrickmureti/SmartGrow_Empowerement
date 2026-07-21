/**
 * HardwareMedia — Phase 11 admin surface for `media_profiles`.
 *
 * ADR-0087 makes media a first-class concept: physical paper/label
 * geometry lives here and drivers inject the paper envelope from a
 * resolved media profile. Operators need a way to add a new label size
 * (e.g. 40×20 mm shelf edge, 102×152 mm shipping) without touching code
 * or template bodies, so this page is the single place where new media
 * are registered.
 *
 * Deliberately scoped to CRUD over `public.media_profiles`. It does NOT
 * bind media to printers (that lives on `printer_profiles.supported_media_ids`
 * and is edited from the printer detail sheet) and it does NOT edit
 * template bodies. Keeping the concerns split matches the ownership
 * matrix in ADR-0087: media / printer capability / template content are
 * three distinct records with three distinct editors.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

type MediaKind = "label" | "receipt" | "sheet" | "continuous";
type Orientation = "portrait" | "landscape";

interface MediaProfile {
  id: string;
  org_id: string;
  code: string;
  name: string;
  width_mm: number;
  height_mm: number | null;
  orientation: Orientation;
  gap_mm: number;
  kind: MediaKind;
  is_default: boolean;
  active: boolean;
  updated_at: string;
}

interface DraftForm {
  id?: string;
  code: string;
  name: string;
  width_mm: string;
  height_mm: string;
  orientation: Orientation;
  gap_mm: string;
  kind: MediaKind;
  is_default: boolean;
  active: boolean;
}

const EMPTY_FORM: DraftForm = {
  code: "",
  name: "",
  width_mm: "",
  height_mm: "",
  orientation: "portrait",
  gap_mm: "3",
  kind: "label",
  is_default: false,
  active: true,
};

function formatDim(w: number, h: number | null): string {
  if (h == null) return `${w} mm × continuous`;
  return `${w} × ${h} mm`;
}

export default function HardwareMedia() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const [rows, setRows] = useState<MediaProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DraftForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("media_profiles")
      .select("id, org_id, code, name, width_mm, height_mm, orientation, gap_mm, kind, is_default, active, updated_at")
      .eq("org_id", orgId)
      .order("kind", { ascending: true })
      .order("width_mm", { ascending: true });
    setLoading(false);
    if (error) {
      toast.error(`Failed to load media profiles: ${error.message}`);
      return;
    }
    setRows((data as MediaProfile[]) ?? []);
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const grouped = useMemo(() => {
    const by: Record<MediaKind, MediaProfile[]> = { label: [], receipt: [], sheet: [], continuous: [] };
    for (const r of rows) by[r.kind]?.push(r);
    return by;
  }, [rows]);

  function startCreate() {
    setEditing({ ...EMPTY_FORM });
  }

  function startEdit(row: MediaProfile) {
    setEditing({
      id: row.id,
      code: row.code,
      name: row.name,
      width_mm: String(row.width_mm),
      height_mm: row.height_mm == null ? "" : String(row.height_mm),
      orientation: row.orientation,
      gap_mm: String(row.gap_mm),
      kind: row.kind,
      is_default: row.is_default,
      active: row.active,
    });
  }

  async function save() {
    if (!editing || !orgId) return;
    const width = Number(editing.width_mm);
    if (!Number.isFinite(width) || width <= 0) {
      toast.error("Width (mm) must be a positive number.");
      return;
    }
    const heightRaw = editing.height_mm.trim();
    const height = heightRaw === "" ? null : Number(heightRaw);
    if (height !== null && (!Number.isFinite(height) || height <= 0)) {
      toast.error("Height (mm) must be blank (continuous) or a positive number.");
      return;
    }
    const gap = Number(editing.gap_mm);
    if (!Number.isFinite(gap) || gap < 0) {
      toast.error("Gap (mm) must be zero or a positive number.");
      return;
    }
    if (!editing.code.trim() || !editing.name.trim()) {
      toast.error("Code and name are required.");
      return;
    }

    setSaving(true);
    const payload = {
      org_id: orgId,
      code: editing.code.trim(),
      name: editing.name.trim(),
      width_mm: width,
      height_mm: height,
      orientation: editing.orientation,
      gap_mm: gap,
      kind: editing.kind,
      is_default: editing.is_default,
      active: editing.active,
    };
    const q = editing.id
      ? supabase.from("media_profiles").update(payload).eq("id", editing.id)
      : supabase.from("media_profiles").insert(payload);
    const { error } = await q;
    setSaving(false);
    if (error) {
      toast.error(`Save failed: ${error.message}`);
      return;
    }
    toast.success(editing.id ? "Media profile updated." : "Media profile created.");
    setEditing(null);
    void load();
  }

  async function remove(row: MediaProfile) {
    if (!confirm(`Delete media profile "${row.name}"? Printers referencing it will lose the binding.`)) return;
    const { error } = await supabase.from("media_profiles").delete().eq("id", row.id);
    if (error) {
      toast.error(`Delete failed: ${error.message}`);
      return;
    }
    toast.success("Media profile deleted.");
    void load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Media profiles</h1>
          <p className="text-sm text-muted-foreground">
            Physical paper &amp; label geometry. Drivers inject the paper envelope
            from the media profile bound to the printer — adding a new size never
            requires editing a template body. See ADR-0087.
          </p>
        </div>
        <Button onClick={startCreate}>
          <Plus className="mr-2 h-4 w-4" /> New media profile
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        (["label", "receipt", "sheet", "continuous"] as MediaKind[]).map((kind) => {
          const list = grouped[kind];
          if (!list || list.length === 0) return null;
          return (
            <Card key={kind}>
              <CardHeader>
                <CardTitle className="capitalize">{kind}</CardTitle>
                <CardDescription>
                  {kind === "label" && "Die-cut thermal labels (product tags, shelf edges, shipping)."}
                  {kind === "receipt" && "Continuous thermal roll receipts."}
                  {kind === "sheet" && "Cut-sheet paper (A4, Letter)."}
                  {kind === "continuous" && "Continuous non-receipt media."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Dimensions</TableHead>
                      <TableHead>Orientation</TableHead>
                      <TableHead>Gap</TableHead>
                      <TableHead>Flags</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">{r.code}</TableCell>
                        <TableCell>{r.name}</TableCell>
                        <TableCell>{formatDim(r.width_mm, r.height_mm)}</TableCell>
                        <TableCell className="capitalize">{r.orientation}</TableCell>
                        <TableCell>{r.gap_mm} mm</TableCell>
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
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })
      )}

      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit media profile" : "New media profile"}</DialogTitle>
            <DialogDescription>
              Enter the physical dimensions in millimetres. For continuous receipt roll,
              leave height blank.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="mp-code">Code</Label>
                  <Input
                    id="mp-code"
                    value={editing.code}
                    onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                    placeholder="e.g. label_40x20"
                  />
                </div>
                <div>
                  <Label htmlFor="mp-kind">Kind</Label>
                  <Select
                    value={editing.kind}
                    onValueChange={(v) => setEditing({ ...editing, kind: v as MediaKind })}
                  >
                    <SelectTrigger id="mp-kind"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="label">Label</SelectItem>
                      <SelectItem value="receipt">Receipt</SelectItem>
                      <SelectItem value="sheet">Sheet</SelectItem>
                      <SelectItem value="continuous">Continuous</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor="mp-name">Name</Label>
                <Input
                  id="mp-name"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Label 40 × 20 mm"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="mp-w">Width (mm)</Label>
                  <Input
                    id="mp-w"
                    value={editing.width_mm}
                    onChange={(e) => setEditing({ ...editing, width_mm: e.target.value })}
                    inputMode="decimal"
                  />
                </div>
                <div>
                  <Label htmlFor="mp-h">Height (mm)</Label>
                  <Input
                    id="mp-h"
                    value={editing.height_mm}
                    onChange={(e) => setEditing({ ...editing, height_mm: e.target.value })}
                    inputMode="decimal"
                    placeholder="blank = continuous"
                  />
                </div>
                <div>
                  <Label htmlFor="mp-gap">Gap (mm)</Label>
                  <Input
                    id="mp-gap"
                    value={editing.gap_mm}
                    onChange={(e) => setEditing({ ...editing, gap_mm: e.target.value })}
                    inputMode="decimal"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="mp-orient">Orientation</Label>
                  <Select
                    value={editing.orientation}
                    onValueChange={(v) => setEditing({ ...editing, orientation: v as Orientation })}
                  >
                    <SelectTrigger id="mp-orient"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="portrait">Portrait</SelectItem>
                      <SelectItem value="landscape">Landscape</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editing.is_default}
                      onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
                    />
                    Default
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
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : editing?.id ? "Save changes" : "Create profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
