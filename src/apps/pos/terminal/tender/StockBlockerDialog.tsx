/**
 * StockBlockerDialog — shown before/at payment confirmation when one or
 * more cart lines exceed the available register stock. Gives the cashier
 * a first-class recovery path (remove line, adjust to available) so they
 * never see the generic "something unexpected happened" toast from the
 * commit RPC.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Trash2, Wand2 } from "lucide-react";

export interface StockBlockerLine {
  itemId: string;
  productId: string;
  name: string;
  requested: number;
  available: number;
}

interface StockBlockerDialogProps {
  open: boolean;
  onClose: () => void;
  lines: StockBlockerLine[];
  onRemoveLine: (line: StockBlockerLine) => void;
  onAdjustLine: (line: StockBlockerLine) => void;
  onRetry?: () => void;
  isBusy?: boolean;
}

export function StockBlockerDialog({
  open,
  onClose,
  lines,
  onRemoveLine,
  onAdjustLine,
  onRetry,
  isBusy,
}: StockBlockerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Insufficient stock
          </DialogTitle>
          <DialogDescription>
            These lines exceed the available stock for this register. Resolve
            each item to continue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {lines.map((line) => (
            <div
              key={line.itemId}
              className="rounded-md border p-3 flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{line.name}</div>
                <div className="text-xs text-muted-foreground">
                  Available: <span className="font-medium">{line.available}</span>{" "}
                  · Requested:{" "}
                  <span className="font-medium">{line.requested}</span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAdjustLine(line)}
                  disabled={isBusy || line.available <= 0}
                >
                  <Wand2 className="h-3.5 w-3.5 mr-1" />
                  Adjust
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onRemoveLine(line)}
                  disabled={isBusy}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isBusy}>
            Back to cart
          </Button>
          {onRetry && (
            <Button onClick={onRetry} disabled={isBusy}>
              Recheck stock
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
