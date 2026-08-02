/**
 * BinLabelDialog — bin label lifecycle: preview, then print.
 *
 * The preview is a *geometry* preview built from the stored `LabelDoc`
 * (position, text, barcode placement). It is deliberately NOT a second
 * barcode rasteriser — ADR-0085 keeps rendering server-side; printing goes
 * through `useLabelPrint` → `PrintService.printLabel` so the workflow-bound
 * label printer resolves per branch/warehouse.
 */
import { useMemo, useState } from "react";
import { Printer, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useLabelPrint } from "@/hooks/inventory/useLabelPrint";
import { WMS_LABEL_KEY } from "@/features/warehouse/labels/wmsLabels";
import type { LocationNode } from "./types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Locations queued for labelling — one, a shelf's worth, or a whole aisle. */
  locations: LocationNode[];
  warehouseId: string | null;
  branchId?: string | null;
}

export function BinLabelDialog({ open, onOpenChange, locations, warehouseId, branchId }: Props) {
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const { print, missingDeviceCta } = useLabelPrint({ branchId, warehouseId });

  const printable = useMemo(() => locations.filter((l) => !!(l.barcode || l.code)), [locations]);

  const runPrint = async () => {
    setBusy(true);
    setDone(0);
    try {
      for (const loc of printable) {
        const code = loc.barcode || loc.code;
        await print({
          templateKey: WMS_LABEL_KEY.BIN,
          workflow: "receiving",
          product: { id: loc.id, name: loc.name || loc.code, sku: loc.code, barcode: code },
          extraVars: {
            location_code: loc.code,
            location_name: loc.name,
            level: loc.structure_level ?? "",
            path: loc.path.join(" / "),
            pick_sequence: loc.pick_sequence ?? "",
            copies,
          },
          sourceDocType: "stock_location",
          sourceDocId: loc.id,
          idempotencyKey: `wms.bin-label:${loc.id}:${Date.now()}`,
        });
        setDone((d) => d + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Print bin labels</DialogTitle>
          <DialogDescription>
            {printable.length} label{printable.length === 1 ? "" : "s"} will be sent to the
            warehouse label printer. Every label carries the location code operators scan.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-64 rounded-md border">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2 p-2">
            {printable.map((l) => (
              <div key={l.id} className="rounded-md border bg-card p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {l.path.slice(0, -1).join(" / ") || "Warehouse"}
                </div>
                <div className="text-lg font-bold leading-tight">{l.code}</div>
                <div className="truncate text-xs text-muted-foreground">{l.name}</div>
                <div className="mt-2 flex h-8 items-end gap-[2px] overflow-hidden" aria-hidden>
                  {barPattern(l.barcode || l.code).map((w, i) => (
                    <span
                      key={i}
                      className={i % 2 ? "bg-transparent" : "bg-foreground"}
                      style={{ width: w, height: "100%" }}
                    />
                  ))}
                </div>
                <div className="text-center font-mono text-[10px] tracking-widest">
                  {l.barcode || l.code}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>

        <div className="flex items-end gap-3">
          <div className="w-32 space-y-1">
            <Label htmlFor="bin-label-copies">Copies each</Label>
            <Input
              id="bin-label-copies"
              type="number"
              min={1}
              max={20}
              value={copies}
              onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          {busy && (
            <p className="pb-2 text-sm text-muted-foreground">
              Printing {done}/{printable.length}…
            </p>
          )}
        </div>

        {missingDeviceCta && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            {missingDeviceCta.message}{" "}
            <a className="underline" href={missingDeviceCta.href}>
              Assign a printer
            </a>
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          <Button onClick={runPrint} disabled={busy || printable.length === 0}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Printer className="mr-2 h-4 w-4" />
            )}
            Print {printable.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Deterministic bar widths so the preview looks like the physical label. */
function barPattern(code: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < code.length * 3; i++) {
    const c = code.charCodeAt(i % code.length);
    out.push(((c + i) % 3) + 1);
  }
  return out;
}
