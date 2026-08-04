/**
 * LpnLabelDialog — Generate → Preview → Validate → Print for plate labels.
 *
 * The compile step runs through the same `renderLabelPayload` the print
 * pipeline uses, so what an operator validates here is byte-identical to
 * what leaves the printer. Reprints require a reason code, which is
 * written to the plate's event ledger.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Printer, Loader2 } from "lucide-react";
import {
  previewLpnLabel, printLpnLabel, REPRINT_REASONS,
  type LpnLabelPreview, type ReprintReason,
} from "./lpnLabels";
import type { LpnOverviewRow } from "./useLpnOps";

interface LpnLabelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string | undefined;
  /** One plate, or a bulk selection. */
  plates: LpnOverviewRow[];
  /** Pre-arm the reprint path (label damaged/lost on the floor). */
  defaultReprint?: boolean;
}

export function LpnLabelDialog({
  open, onOpenChange, orgId, plates, defaultReprint = false,
}: LpnLabelDialogProps) {
  const [preview, setPreview] = useState<LpnLabelPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [copies, setCopies] = useState("1");
  const [isReprint, setIsReprint] = useState(defaultReprint);
  const [reason, setReason] = useState<ReprintReason>("damaged");

  const first = plates[0];

  useEffect(() => {
    if (!open || !orgId || !first) return;
    setIsReprint(defaultReprint);
    setLoading(true);
    previewLpnLabel(orgId, first)
      .then(setPreview)
      .catch((e) => setPreview({ ok: false, error: e instanceof Error ? e.message : "Compile failed" }))
      .finally(() => setLoading(false));
  }, [open, orgId, first, defaultReprint]);

  async function run() {
    if (!orgId) return toast.error("No active organization");
    setPrinting(true);
    let ok = 0;
    for (const plate of plates) {
      const res = await printLpnLabel({
        orgId,
        plate,
        copies: Math.max(1, Number(copies) || 1),
        isReprint,
        reason: isReprint ? reason : null,
      });
      if (res.success) ok += 1;
      else if (plates.length === 1) toast.error(res.error ?? "Print failed");
    }
    setPrinting(false);
    if (ok) toast.success(`${ok}/${plates.length} label${plates.length > 1 ? "s" : ""} sent to printer`);
    if (ok === plates.length) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {plates.length > 1 ? `Print ${plates.length} plate labels` : `Label ${first?.code ?? ""}`}
          </DialogTitle>
          <DialogDescription>
            Compiled from the <span className="font-mono">wms.label.lpn</span> template and the
            printer bound to this warehouse.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-3">
            {loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Compiling preview…
              </p>
            ) : preview?.ok ? (
              <>
                <div className="mb-2 flex flex-wrap gap-2">
                  <Badge variant="outline">{preview.engine?.toUpperCase()} v{preview.version}</Badge>
                  {preview.media && (
                    <Badge variant="outline">
                      {preview.media.widthMm}×{preview.media.heightMm ?? "auto"}mm @ {preview.media.dpi}dpi
                    </Badge>
                  )}
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-muted-foreground">
                  {preview.body ?? "Binary payload — validated by the driver at dispatch."}
                </pre>
              </>
            ) : (
              <p className="text-sm text-destructive">{preview?.error ?? "Preview unavailable"}</p>
            )}
          </div>

          <div className="min-w-0 grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Copies</Label>
              <Input type="number" min="1" value={copies} onChange={(e) => setCopies(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Print kind</Label>
              <Select value={isReprint ? "reprint" : "original"} onValueChange={(v) => setIsReprint(v === "reprint")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="original">Original</SelectItem>
                  <SelectItem value="reprint">Reprint</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {isReprint && (
            <div className="space-y-2">
              <Label>Reprint reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as ReprintReason)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REPRINT_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={run} disabled={printing || !plates.length}>
            {printing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
