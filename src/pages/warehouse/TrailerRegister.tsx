/**
 * Trailer Register — trailer master data (ADR 0086).
 *
 * A trailer is a first-class entity, not a free-text string on a visit.
 * `gate_check_in` resolves or creates the master row, so this register is
 * where fleet, capacity and ownership get curated, and where the full
 * visit history for a unit is read.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Container, Plus, Search } from "lucide-react";
import { format } from "date-fns";
import { useSaveTrailer, useTrailers, useTrailerVisitHistory, useYardCarriers } from "@/features/warehouse/yard/useYard";
import {
  dwellMinutes,
  formatDwell,
  TRAILER_OWNERSHIP_LABEL,
  TRAILER_TYPE_LABEL,
  VISIT_STATUS_LABEL,
  type TrailerRow,
} from "@/features/warehouse/yard/yardModel";

const NONE = "__none__";

function TrailerDialog({
  open,
  onOpenChange,
  trailer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trailer: TrailerRow | null;
}) {
  const [code, setCode] = useState(trailer?.code ?? "");
  const [type, setType] = useState(trailer?.trailer_type ?? "dry_van");
  const [ownership, setOwnership] = useState(trailer?.ownership ?? "carrier");
  const [carrierId, setCarrierId] = useState(trailer?.carrier_id ?? NONE);
  const [lengthFt, setLengthFt] = useState(trailer?.length_ft != null ? String(trailer.length_ft) : "");
  const [active, setActive] = useState(trailer?.is_active ?? true);
  const carriers = useYardCarriers();
  const save = useSaveTrailer();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{trailer ? `Edit ${trailer.code}` : "New trailer"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Trailer code *</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="TRL-4471" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as TrailerRow["trailer_type"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TRAILER_TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Ownership</Label>
              <Select value={ownership} onValueChange={(v) => setOwnership(v as TrailerRow["ownership"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TRAILER_OWNERSHIP_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Carrier</Label>
            <Select value={carrierId ?? NONE} onValueChange={setCarrierId}>
              <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {(carriers.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3 items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">Length (ft)</Label>
              <Input type="number" value={lengthFt} onChange={(e) => setLengthFt(e.target.value)} />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch checked={active} onCheckedChange={setActive} id="trailer-active" />
              <Label htmlFor="trailer-active" className="text-xs">Active</Label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!code.trim() || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: trailer?.id,
                  code,
                  trailerType: type,
                  ownership,
                  carrierId: carrierId === NONE ? null : carrierId,
                  lengthFt: lengthFt === "" ? null : Number(lengthFt),
                  isActive: active,
                },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TrailerHistorySheet({ trailer, onClose }: { trailer: TrailerRow | null; onClose: () => void }) {
  const history = useTrailerVisitHistory(trailer?.id ?? null);
  return (
    <Sheet open={!!trailer} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{trailer?.code}</SheetTitle>
          <SheetDescription>
            {trailer ? TRAILER_TYPE_LABEL[trailer.trailer_type] : ""} ·{" "}
            {trailer ? TRAILER_OWNERSHIP_LABEL[trailer.ownership] : ""} · {trailer?.carrier?.name ?? "no carrier"}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          <h3 className="text-sm font-medium mb-2">Visit history</h3>
          {history.isLoading ? (
            <LoadingState />
          ) : (history.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">This trailer has not visited site yet.</p>
          ) : (
            <ol className="space-y-2">
              {(history.data ?? []).map((v) => (
                <li key={v.id} className="rounded-md border p-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{format(new Date(v.arrived_at), "dd MMM yyyy HH:mm")}</span>
                    <Badge variant="outline" className="text-[10px]">{VISIT_STATUS_LABEL[v.status]}</Badge>
                  </div>
                  <p className="text-muted-foreground mt-0.5">
                    Dwell {formatDwell(dwellMinutes(v))} · seal {v.seal_in || "—"} → {v.seal_out || "—"}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function TrailerRegister() {
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<{ open: boolean; trailer: TrailerRow | null }>({ open: false, trailer: null });
  const [historyFor, setHistoryFor] = useState<TrailerRow | null>(null);
  const trailers = useTrailers(search);

  return (
    <>
      <PageHeader
        title="Trailer Register"
        description="Master data for every trailer, container and vehicle that visits your sites."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/warehouse-app/yard">Control tower</Link>
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => setDialog({ open: true, trailer: null })}>
              <Plus className="h-3.5 w-3.5" /> New trailer
            </Button>
          </div>
        }
      />
      <PageBody>
        <div className="relative w-full sm:w-[280px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="h-9 pl-7"
            placeholder="Search trailer code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <Section title="Trailers">
          {trailers.isLoading ? (
            <LoadingState />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Ownership</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Length</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(trailers.data ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-10">
                      No trailers yet. Gate check-in registers unknown trailers automatically.
                    </TableCell>
                  </TableRow>
                ) : (
                  (trailers.data ?? []).map((t) => (
                    <TableRow key={t.id} className="cursor-pointer" onClick={() => setHistoryFor(t)}>
                      <TableCell className="font-medium">
                        {t.code}
                        {!t.is_active && <Badge variant="outline" className="ml-2 text-[10px]">Inactive</Badge>}
                      </TableCell>
                      <TableCell>{TRAILER_TYPE_LABEL[t.trailer_type] ?? t.trailer_type}</TableCell>
                      <TableCell>{TRAILER_OWNERSHIP_LABEL[t.ownership] ?? t.ownership}</TableCell>
                      <TableCell>{t.carrier?.name ?? "—"}</TableCell>
                      <TableCell>{t.length_ft != null ? `${t.length_ft} ft` : "—"}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDialog({ open: true, trailer: t });
                          }}
                        >
                          Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      {dialog.open && (
        <TrailerDialog
          key={dialog.trailer?.id ?? "new"}
          open={dialog.open}
          onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))}
          trailer={dialog.trailer}
        />
      )}
      <TrailerHistorySheet trailer={historyFor} onClose={() => setHistoryFor(null)} />
    </>
  );
}
