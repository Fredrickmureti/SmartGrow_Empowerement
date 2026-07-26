/**
 * HardwareCapability — Phase 2b admin surface for printer capability fields
 * on the unified `device_assignments` registry.
 *
 * Owns the "hardware capability" slice: which command language the printer
 * speaks (`command_language`), its native resolution (`dpi`), printable
 * margins (`margins_mm`), and the set of media profiles it supports
 * (`supported_media_ids[]`). Drivers read these fields directly from the
 * resolved device row.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { Pencil, Cpu } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

type CommandLanguage = "zpl" | "epl" | "escpos" | "pdf";

interface DeviceRow {
  id: string;
  organization_id: string;
  display_name: string;
  transport: string | null;
  command_language: CommandLanguage | null;
  dpi: number | null;
  margins_mm: Record<string, number> | null;
  supported_media_ids: string[] | null;
  enabled: boolean;
  role: string;
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
  command_language: CommandLanguage;
  dpi: string;
  margins_top: string;
  margins_right: string;
  margins_bottom: string;
  margins_left: string;
  supported_media_ids: string[];
}

const COMMAND_LANGUAGES: Array<{ value: CommandLanguage; label: string; hint: string }> = [
  { value: "zpl", label: "ZPL", hint: "Zebra / Zebra-compatible label printers" },
  { value: "epl", label: "EPL", hint: "Eltron / legacy Zebra 2 label printers" },
  { value: "escpos", label: "ESC/POS", hint: "Thermal receipt printers (Epson TM, Star mC-Print, generic 58/80mm)" },
  { value: "pdf", label: "PDF", hint: "A4 / A5 / laser office printers" },
];

const DPI_OPTIONS = [203, 300, 600];
const PRINTER_ROLES = ["receipt_printer", "a4_printer", "label_printer"];

function parseMargins(m: Record<string, number> | null | undefined): {
  top: string; right: string; bottom: string; left: string;
} {
  return {
    top: String(m?.top ?? 0),
    right: String(m?.right ?? 0),
    bottom: String(m?.bottom ?? 0),
    left: String(m?.left ?? 0),
  };
}

export default function HardwareCapability() {
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
        .select("id, organization_id, display_name, transport, command_language, dpi, margins_mm, supported_media_ids, enabled, role")
        .eq("organization_id", orgId)
        .in("role", PRINTER_ROLES)
        .order("display_name", { ascending: true }),
      supabase
        .from("media_profiles")
        .select("id, code, name, width_mm, height_mm")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("name", { ascending: true }),
    ]);
    if (pRes.error) {
      toast.error(`Failed to load printers: ${pRes.error.message}`);
    } else {
      setRows((pRes.data ?? []) as unknown as DeviceRow[]);
    }
    if (mRes.error) {
      toast.error(`Failed to load media profiles: ${mRes.error.message}`);
    } else {
      setMedia((mRes.data ?? []) as MediaOption[]);
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mediaById = useMemo(() => {
    const m = new Map<string, MediaOption>();
    for (const opt of media) m.set(opt.id, opt);
    return m;
  }, [media]);

  const openEdit = useCallback((p: DeviceRow) => {
    const margins = parseMargins(p.margins_mm);
    setEditing({
      id: p.id,
      label: p.display_name,
      command_language: (p.command_language ?? "pdf") as CommandLanguage,
      dpi: String(p.dpi ?? 203),
      margins_top: margins.top,
      margins_right: margins.right,
      margins_bottom: margins.bottom,
      margins_left: margins.left,
      supported_media_ids: p.supported_media_ids ?? [],
    });
  }, []);

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
    const margins_mm = {
      top: Number(editing.margins_top) || 0,
      right: Number(editing.margins_right) || 0,
      bottom: Number(editing.margins_bottom) || 0,
      left: Number(editing.margins_left) || 0,
    };
    setSaving(true);
    // Keep role coherent with command_language.
    const newRole =
      editing.command_language === "zpl" || editing.command_language === "epl"
        ? "label_printer"
        : editing.command_language === "escpos"
          ? "receipt_printer"
          : "a4_printer";
    const { error } = await supabase
      .from("device_assignments")
      .update({
        command_language: editing.command_language,
        dpi,
        margins_mm,
        supported_media_ids: editing.supported_media_ids,
        role: newRole,
      } as never)
      .eq("id", editing.id);
    setSaving(false);
    if (error) {
      toast.error(`Failed to save capability: ${error.message}`);
      return;
    }
    toast.success("Printer capability saved");
    setEditing(null);
    void refresh();
  }, [editing, refresh]);

  return (
    <div className="p-6 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Cpu className="h-5 w-5" /> Printer capability
              </CardTitle>
              <CardDescription>
                Command language, native resolution, printable margins, and the media a printer
                is allowed to receive. Drivers read these fields at dispatch time — no code change
                is needed to onboard a new printer model.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No printers yet. Add one from{" "}
              <span className="font-medium">Settings → Printing → Printer profiles</span>,
              then return here to set its command language, DPI and supported media.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Printer</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Command language</TableHead>
                  <TableHead className="text-right">DPI</TableHead>
                  <TableHead>Supported media</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const mediaCount = p.supported_media_ids?.length ?? 0;
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
                      <TableCell>
                        {p.command_language ? (
                          <Badge variant="secondary">{p.command_language}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">unset</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.dpi ?? <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {mediaCount === 0 ? (
                          <span className="text-xs text-muted-foreground">none</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {(p.supported_media_ids ?? []).slice(0, 3).map((id) => {
                              const m = mediaById.get(id);
                              return (
                                <Badge key={id} variant="outline" className="text-xs">
                                  {m ? m.name : id.slice(0, 6)}
                                </Badge>
                              );
                            })}
                            {mediaCount > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{mediaCount - 3}
                              </Badge>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Hardware capability — {editing?.label}
            </DialogTitle>
            <DialogDescription>
              These fields tell the label dispatch pipeline how to talk to this printer.
              Media it doesn't support will not appear as options in label workflows.
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Command language</Label>
                  <Select
                    value={editing.command_language}
                    onValueChange={(v) =>
                      setEditing({ ...editing, command_language: v as CommandLanguage })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {COMMAND_LANGUAGES.map((cl) => (
                        <SelectItem key={cl.value} value={cl.value}>
                          {cl.label} — <span className="text-muted-foreground">{cl.hint}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
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
              </div>

              <div className="space-y-1.5">
                <Label>Printable margins (mm)</Label>
                <div className="grid grid-cols-4 gap-2">
                  {(["top", "right", "bottom", "left"] as const).map((side) => (
                    <div key={side} className="space-y-1">
                      <Label className="text-xs text-muted-foreground capitalize">{side}</Label>
                      <Input
                        type="number"
                        step="0.1"
                        min="0"
                        value={editing[`margins_${side}` as keyof DraftForm] as string}
                        onChange={(e) =>
                          setEditing({ ...editing, [`margins_${side}`]: e.target.value } as DraftForm)
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Supported media profiles</Label>
                <p className="text-xs text-muted-foreground">
                  Only checked media are eligible when this printer is picked in a label workflow.
                  The first checked profile is the default when no override is passed.
                </p>
                <div className="max-h-60 overflow-y-auto rounded-md border divide-y">
                  {media.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-3">
                      No media profiles yet. Add one in Media profiles first.
                    </p>
                  ) : (
                    media.map((m) => {
                      const checked = editing.supported_media_ids.includes(m.id);
                      return (
                        <label
                          key={m.id}
                          className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-accent/50"
                        >
                          <Checkbox
                            checked={checked}
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
                      );
                    })
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
              {saving ? "Saving…" : "Save capability"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
