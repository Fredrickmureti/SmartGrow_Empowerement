/**
 * LabelVerifyDialog — the audit walk after a labelling run.
 *
 * A printed label is a claim; a scanned label is a fact. The supervisor
 * walks the aisle with an RF gun, scans each label, and this dialog turns
 * the run into a pass/fail list backed by `resolve_location_identity`.
 * Failures can be sent straight back to the printer.
 */
import { useState } from "react";
import { Check, Printer, ScanLine, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useLabelVerification } from "./useLabelVerification";
import { useWmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";
import type { LocationNode } from "./types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  warehouseId: string | null;
  /** The run being verified — everything expected to carry a label. */
  expected: LocationNode[];
  onReprint: (nodes: LocationNode[]) => void;
}

export function LabelVerifyDialog({
  open,
  onOpenChange,
  warehouseId,
  expected,
  onReprint,
}: Props) {
  const [typed, setTyped] = useState("");
  const { entries, stats, record, reset, Flash } = useLabelVerification(warehouseId);

  useWmsScanIntent({
    intent: "pick.location",
    label: "layout.verify",
    enabled: open,
    onScan: ({ resolveCode }) => void record(resolveCode),
  });

  const verifiedIds = new Set(
    entries.filter((e) => e.outcome === "verified").map((e) => e.locationId),
  );
  const outstanding = expected.filter((n) => !verifiedIds.has(n.id));

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Verify labels</DialogTitle>
          <DialogDescription>
            Walk the run and scan each label. Anything that does not resolve to a live position
            is a label to reprint before the bins go live.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 grid grid-cols-3 gap-2">
          <Tile label="Scanned" value={stats.total} />
          <Tile label="Confirmed" value={stats.verified} />
          <Tile label="Failed" value={stats.failed} tone={stats.failed ? "danger" : undefined} />
        </div>

        <div className="relative">
          <ScanLine className="pointer-events-none absolute left-2 top-2.5 z-10 h-4 w-4 text-muted-foreground" />
          <ScanTextField
            autoFocus
            className="pl-8 font-mono"
            placeholder="Scan or type a label…"
            cameraLabel="Scan the printed label"
            continuous
            allowRepeats
            value={typed}
            onChange={setTyped}
            onEnter={(v) => {
              void record(v);
              setTyped("");
            }}
          />
        </div>


        <div className="max-h-56 overflow-auto rounded-md border">
          {entries.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              No scans yet. {expected.length.toLocaleString()} position
              {expected.length === 1 ? "" : "s"} in this run.
            </p>
          ) : (
            entries.map((e) => (
              <div
                key={`${e.raw}-${e.at}`}
                className="flex items-center justify-between border-b px-3 py-2 text-sm last:border-0"
              >
                <span className="font-mono">{e.code ?? e.raw}</span>
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    e.outcome === "verified" ? "text-primary" : "text-destructive",
                  )}
                >
                  {e.outcome === "verified" ? (
                    <>
                      <Check className="h-3.5 w-3.5" /> confirmed
                    </>
                  ) : (
                    <>
                      <TriangleAlert className="h-3.5 w-3.5" />
                      {e.outcome === "inactive" ? "blocked position" : "unknown label"}
                    </>
                  )}
                </span>
              </div>
            ))
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Badge variant="secondary">
            {outstanding.length.toLocaleString()} not yet confirmed
          </Badge>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              disabled={outstanding.length === 0}
              onClick={() => {
                onReprint(outstanding);
                onOpenChange(false);
              }}
            >
              <Printer className="mr-2 h-4 w-4" /> Reprint outstanding
            </Button>
          </div>
        </DialogFooter>
        <Flash />
      </DialogContent>
    </Dialog>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-semibold", tone === "danger" && "text-destructive")}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}
