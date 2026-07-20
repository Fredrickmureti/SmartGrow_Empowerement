/**
 * PrinterProfilesCard — Wave W7 follow-up (ADR-0008) + Receipt overhaul Phase 2.
 *
 * Lists named physical printers for the current business and lets admins
 * create / edit / soft-delete them.
 *
 * Phase 2 (receipt overhaul) added the physical capability fields the
 * ESC/POS builder consumes — `font`, `columns_override`, `margin_cols`,
 * `cutter`, `qr_native`, `code128_native`. Without UI for these, operators
 * could not stop overflow on real 80mm/58mm/40mm printers whose true Font A
 * column count differs from the engine defaults (e.g. 80mm Font A printers
 * that physically print 42 cols, not 48). The dialog now exposes them and
 * shows a live "resolved printable width" pill.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Printer, Loader2, Info } from "lucide-react";
import {
  usePrinterProfiles,
  PRINTER_TRANSPORTS,
  type PrinterProfile,
  type PrinterProfileInput,
  type PrinterTransport,
  type PrinterFont,
  type PrinterCutter,
} from "@/hooks/usePrinterProfiles";
import type { PaperFormat } from "@/hooks/useDocumentPrintPolicies";
import { resolvePrinterProfile, contentWidth, type PaperWidth } from "@/lib/receipt/engine/PrinterProfile";

const PAPER_OPTIONS: { value: PaperFormat; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "US Letter" },
  { value: "a5", label: "A5" },
  { value: "80mm", label: "Thermal 80 mm — continuous roll" },
  { value: "58mm", label: "Thermal 58 mm — continuous roll" },
  { value: "40mm", label: "Thermal 40 mm — continuous roll" },
];


const THERMAL_PAPERS: PaperFormat[] = ["80mm", "58mm", "40mm"];

interface Props {
  businessId: string;
  canWrite: boolean;
}

const EMPTY: PrinterProfileInput = {
  label: "",
  transport: "browser",
  address: "",
  paper_format: "a4",
  escpos_codepage: "CP858",
  notes: "",
  font: "A",
  columns_override: null,
  margin_cols: null,
  cutter: "full",
  qr_native: true,
  code128_native: true,
  is_calibrated: false,
};

export function PrinterProfilesCard({ businessId, canWrite }: Props) {
  const { activeProfiles, loading, saving, create, update, remove } = usePrinterProfiles(businessId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PrinterProfile | null>(null);
  const [form, setForm] = useState<PrinterProfileInput>(EMPTY);
  const [confirmDelete, setConfirmDelete] = useState<PrinterProfile | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setDialogOpen(true);
  };

  const openEdit = (p: PrinterProfile) => {
    setEditing(p);
    setForm({
      label: p.label,
      transport: p.transport,
      address: p.address ?? "",
      paper_format: p.paper_format,
      escpos_codepage: p.escpos_codepage ?? "",
      notes: p.notes ?? "",
      font: p.font,
      columns_override: p.columns_override,
      margin_cols: p.margin_cols,
      cutter: p.cutter,
      qr_native: p.qr_native,
      code128_native: p.code128_native,
      is_calibrated: p.is_calibrated,
    });
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!form.label.trim()) return;
    const ok = editing ? await update(editing.id, form) : await create(form);
    if (ok) setDialogOpen(false);
  };

  const transportMeta = PRINTER_TRANSPORTS.find((t) => t.value === form.transport);
  const isThermalForm = THERMAL_PAPERS.includes(form.paper_format);

  // Live "resolved printable width" — what the ESC/POS builder will use.
  const resolved = useMemo(() => {
    if (!isThermalForm) return null;
    const profile = resolvePrinterProfile({
      paper: form.paper_format as PaperWidth,
      font: (form.font ?? "A") as PrinterFont,
      marginCols: form.margin_cols ?? undefined,
      columnsOverride: form.columns_override ?? undefined,
    });
    return { columns: profile.columns, content: contentWidth(profile), margin: profile.marginCols };
  }, [form.paper_format, form.font, form.margin_cols, form.columns_override, isThermalForm]);

  const setNumOrNull = (key: "columns_override" | "margin_cols", raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setForm((f) => ({ ...f, [key]: null }));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    setForm((f) => ({ ...f, [key]: Math.floor(n) }));
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Printer className="h-4 w-4" />
            Physical printers
          </CardTitle>
          <CardDescription>
            Named devices that document policies can target for auto-print. For thermal printers,
            the capability fields below (font, columns override, margins, cutter) are what stop
            receipts from overflowing the paper.
          </CardDescription>
        </div>
        {canWrite && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add printer
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : activeProfiles.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center">
            No printers yet. Add one to enable auto-print routing in the policies below.
          </div>
        ) : (
          <div className="space-y-2">
            {activeProfiles.map((p) => {
              const isThermal = THERMAL_PAPERS.includes(p.paper_format);
              const r = isThermal
                ? resolvePrinterProfile({
                    paper: p.paper_format as PaperWidth,
                    font: p.font,
                    marginCols: p.margin_cols ?? undefined,
                    columnsOverride: p.columns_override ?? undefined,
                  })
                : null;
              return (
                <div
                  key={p.id}
                  className="grid grid-cols-[1.4fr_1.2fr_1.4fr_0.9fr_auto] gap-2 items-center text-xs border-b last:border-b-0 pb-2"
                >
                  <div>
                    <div className="font-medium">{p.label}</div>
                    {isThermal && (
                      <div className="text-[10px] text-muted-foreground">
                        Font {p.font} · {r?.columns} cols · margin {r?.marginCols} · content {r ? contentWidth(r) : "—"}
                      </div>
                    )}
                  </div>
                  <div className="text-muted-foreground">
                    {PRINTER_TRANSPORTS.find((t) => t.value === p.transport)?.label ?? p.transport}
                  </div>
                  <div className="text-muted-foreground truncate" title={p.address ?? ""}>
                    {p.address || <span className="italic">—</span>}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Badge variant="secondary" className="text-[10px]">{p.paper_format}</Badge>
                    {isThermal && p.is_calibrated && p.columns_override != null && (
                      <Badge variant="outline" className="text-[10px]" title="Custom column count">
                        {p.columns_override}c
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {canWrite && (
                      <>
                        <Button size="icon" variant="ghost" onClick={() => openEdit(p)} title="Edit">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setConfirmDelete(p)}
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit printer" : "Add printer"}</DialogTitle>
            <DialogDescription>
              Configure a named physical printer. For thermal printers, the capability fields
              control the actual column grid the ESC/POS builder uses.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
            <div>
              <Label className="text-xs">Label</Label>
              <Input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="Front desk thermal"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Transport</Label>
                <Select
                  value={form.transport}
                  onValueChange={(v) => setForm({ ...form, transport: v as PrinterTransport })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRINTER_TRANSPORTS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Paper</Label>
                <Select
                  value={form.paper_format}
                  onValueChange={(v) => setForm({ ...form, paper_format: v as PaperFormat })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAPER_OPTIONS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-xs">Address</Label>
              <Input
                value={form.address ?? ""}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder={transportMeta?.addressHint}
                disabled={form.transport === "browser"}
              />
              <p className="text-[10px] text-muted-foreground mt-1">{transportMeta?.addressHint}</p>
            </div>

            {/* Thermal capability fields ----------------------------------- */}
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold flex items-center gap-1.5">
                  <Printer className="h-3.5 w-3.5" />
                  Thermal capabilities
                </div>
                {isThermalForm && resolved && (
                  <Badge variant="outline" className="text-[10px]" title="Live resolved printable grid">
                    {resolved.columns} cols · {resolved.content} content · margin {resolved.margin}
                  </Badge>
                )}
              </div>

              {!isThermalForm && (
                <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  These fields are ignored for non-thermal paper formats. They drive the ESC/POS
                  column grid only.
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Font</Label>
                  <Select
                    value={form.font ?? "A"}
                    onValueChange={(v) => setForm({ ...form, font: v as PrinterFont })}
                    disabled={!isThermalForm}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="A">A — wider glyphs (default)</SelectItem>
                      <SelectItem value="B">B — small glyphs, more columns</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Cutter</Label>
                  <Select
                    value={form.cutter ?? "full"}
                    onValueChange={(v) => setForm({ ...form, cutter: v as PrinterCutter })}
                    disabled={!isThermalForm}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">Full cut</SelectItem>
                      <SelectItem value="partial">Partial cut</SelectItem>
                      <SelectItem value="none">None (feed only)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border bg-background px-2.5 py-1.5">
                <div>
                  <Label className="text-xs">Calibrated profile</Label>
                  <p className="text-[10px] text-muted-foreground">
                    Enable only after a test print confirms the selected font and column count fit.
                  </p>
                </div>
                <Switch
                  checked={form.is_calibrated ?? false}
                  onCheckedChange={(v) => setForm({ ...form, is_calibrated: v })}
                  disabled={!isThermalForm || form.columns_override == null}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Columns override</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={16}
                    max={96}
                    value={form.columns_override ?? ""}
                    onChange={(e) => setNumOrNull("columns_override", e.target.value)}
                    placeholder="auto"
                    disabled={!isThermalForm}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Leave blank for the font/paper default. Common 80 mm: 42, 48, 64. 58 mm: 30, 32, 42.
                  </p>
                </div>
                <div>
                  <Label className="text-xs">Margin (cols, each side)</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={6}
                    value={form.margin_cols ?? ""}
                    onChange={(e) => setNumOrNull("margin_cols", e.target.value)}
                    placeholder="auto"
                    disabled={!isThermalForm}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Blank uses the paper-aware default (1 on 40/58 mm, 2 on 80 mm).
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center justify-between rounded-md border bg-background px-2.5 py-1.5">
                  <div>
                    <Label className="text-xs">Native QR</Label>
                    <p className="text-[10px] text-muted-foreground">Printer renders QR via GS ( k</p>
                  </div>
                  <Switch
                    checked={form.qr_native ?? true}
                    onCheckedChange={(v) => setForm({ ...form, qr_native: v })}
                    disabled={!isThermalForm}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border bg-background px-2.5 py-1.5">
                  <div>
                    <Label className="text-xs">Native Code 128</Label>
                    <p className="text-[10px] text-muted-foreground">Printer renders Code 128 barcodes</p>
                  </div>
                  <Switch
                    checked={form.code128_native ?? true}
                    onCheckedChange={(v) => setForm({ ...form, code128_native: v })}
                    disabled={!isThermalForm}
                  />
                </div>
              </div>
            </div>

            <div>
              <Label className="text-xs">ESC/POS code page</Label>
              <Input
                value={form.escpos_codepage ?? ""}
                onChange={(e) => setForm({ ...form, escpos_codepage: e.target.value })}
                placeholder="CP858"
              />
            </div>
            <div>
              <Label className="text-xs">Notes</Label>
              <Textarea
                rows={2}
                value={form.notes ?? ""}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saving || !form.label.trim()}>
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {editing ? "Save changes" : "Add printer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove printer?</AlertDialogTitle>
            <AlertDialogDescription>
              "{confirmDelete?.label}" will be deactivated. Existing policies pointing at it will
              fall back to operator-confirmed printing until reassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (confirmDelete) await remove(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
