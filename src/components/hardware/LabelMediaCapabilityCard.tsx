/**
 * LabelMediaCapabilityCard — the surviving, load-bearing slice of the
 * retired `/platform/hardware/capability` page.
 *
 * Audit 2026-07-28: of the four capability fields that page edited, only
 * `dpi` and `supported_media_ids` are read at runtime — by
 * `src/services/printing/labelDispatch.ts` (`resolvePrinterMedia`) when
 * resolving the label envelope for ZPL/EPL rendering. `command_language`
 * and `margins_mm` were written and displayed but never read anywhere, and
 * `command_language` additionally rewrote `device_assignments.role`, giving
 * that column two writers. Both are gone.
 *
 * This card therefore edits label media capability ONLY, lives on the
 * Devices page next to where `role` is already set, and is shown only for
 * `label_printer` devices — the sole consumer of these two fields.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Pencil, Ruler } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

interface DeviceRow {
  id: string;
  display_name: string;
  transport: string | null;
  dpi: number | null;
  supported_media_ids: string[] | null;
  enabled: boolean;
}

interface MediaOption {
  id: string;
  code: string;
  name: string;
  width_mm: number;
  height_mm: number | null;
}

interface DraftForm {
  id: string;
  label: string;
  dpi: string;
  supported_media_ids: string[];
}

const DPI_OPTIONS = [203, 300, 600];

export function LabelMediaCapabilityCard() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;

  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [media, setMedia] = useState<MediaOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DraftForm | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const [pRes, mRes] = await Promise.all([
      supabase
        .from("device_assignments")
        .select("id, display_name, transport, dpi, supported_media_ids, enabled")
        .eq("organization_id", orgId)
        .eq("role", "label_printer")
        .order("display_name", { ascending: true }),
      supabase
        .from("media_profiles")
        .select("id, code, name, width_mm, height_mm")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("name", { ascending: true }),
    ]);
    if (pRes.error) toast.error(`Failed to load label printers: ${pRes.error.message}`);
    else setRows((pRes.data ?? []) as unknown as DeviceRow[]);
    if (mRes.error) toast.error(`Failed to load label media: ${mRes.error.message}`);
    else setMedia((mRes.data ?? []) as MediaOption[]);
    setLoading(false);
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const mediaById = useMemo(() => {
    const m = new Map<string, MediaOption>();
    for (const opt of media) m.set(opt.id, opt);
    return m;
  }, [media]);

  const toggleMedia = useCallback((mediaId: string) => {
    setEditing((prev) => {
      if (!prev) return prev;
      const has = prev.supported_media_ids.includes(mediaId);
      return {
        ...prev,
        supported_media_ids: has
          ? prev.supported_media_ids.filter((x) => x !== mediaId)
          : [...prev.supported_media_ids, mediaId],
      };
    });
  }, []);

  const save = useCallback(async () => {
    if (!editing) return;
    const dpi = parseInt(editing.dpi, 10);
    if (!Number.isFinite(dpi) || dpi <= 0) {
      toast.error("DPI must be a positive integer");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("device_assignments")
      .update({ dpi, supported_media_ids: editing.supported_media_ids } as never)
      .eq("id", editing.id);
    setSaving(false);
    if (error) {
      toast.error(`Failed to save label media: ${error.message}`);
      return;
    }
    toast.success("Label media saved");
    setEditing(null);
    void refresh();
  }, [editing, refresh]);

  if (!loading && rows.length === 0) return null;

  return (
    <>
      <Card data-testid="label-media-capability-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Ruler className="h-4 w-4" /> Label media capability
          </CardTitle>
          <CardDescription>
            Resolution and the label media each label printer is allowed to receive.
            Label dispatch resolves the print envelope from this. Document paper size
            (80 mm, A4, …) is set in{" "}
            <Link to="/platform/hardware/policies" className="underline">Output policies</Link>,
            not here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Printer</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead className="text-right">DPI</TableHead>
                  <TableHead>Label media</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const count = p.supported_media_ids?.length ?? 0;
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        {p.display_name}
                        {!p.enabled && (
                          <Badge variant="outline" className="ml-2 text-xs">inactive</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {p.transport ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.dpi ?? <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {count === 0 ? (
                          <span className="text-xs text-muted-foreground">any (org default)</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {(p.supported_media_ids ?? []).slice(0, 3).map((id) => (
                              <Badge key={id} variant="outline" className="text-xs">
                                {mediaById.get(id)?.name ?? id.slice(0, 6)}
                              </Badge>
                            ))}
                            {count > 3 && (
                              <Badge variant="outline" className="text-xs">+{count - 3}</Badge>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing({
                            id: p.id,
                            label: p.display_name,
                            dpi: String(p.dpi ?? 203),
                            supported_media_ids: p.supported_media_ids ?? [],
                          })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Label media — {editing?.label}</DialogTitle>
            <DialogDescription>
              Label dispatch uses the first checked profile when no explicit media is
              passed. Leave everything unchecked to fall back to the organisation default.
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="space-y-4 py-2">
              <div className="space-y-1.5 max-w-[12rem]">
                <Label>DPI</Label>
                <Select
                  value={editing.dpi}
                  onValueChange={(v) => setEditing({ ...editing, dpi: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DPI_OPTIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>{d} dpi</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Supported label media</Label>
                <div className="max-h-60 overflow-y-auto rounded-md border divide-y">
                  {media.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-3">
                      No label media yet. Add one in Label media first.
                    </p>
                  ) : (
                    media.map((m) => (
                      <label
                        key={m.id}
                        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-accent/50"
                      >
                        <Checkbox
                          checked={editing.supported_media_ids.includes(m.id)}
                          onCheckedChange={() => toggleMedia(m.id)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{m.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {m.code} · {m.width_mm}
                            {m.height_mm != null ? ` × ${m.height_mm}` : " × continuous"} mm
                          </div>
                        </div>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default LabelMediaCapabilityCard;
