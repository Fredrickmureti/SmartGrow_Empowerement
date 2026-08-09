/**
 * InvoiceLineCreditPicker — the "reference document" pick list for credit
 * notes. The operator ticks the invoice lines being credited and sets the
 * quantity per line (capped at what was invoiced) instead of retyping the
 * item as free text.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { NumericInput } from "@/components/ui/numeric-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from "@/design-system/primitives/LoadingState";
import type { CreditableInvoiceLine } from "./useInvoiceCreditableLines";

export interface PickedCreditLine {
  line: CreditableInvoiceLine;
  quantity: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceNumber?: string | null;
  lines: CreditableInvoiceLine[];
  isLoading: boolean;
  error: string | null;
  /** Lines already on the document — pre-ticked with their quantity. */
  existing?: Record<string, number>;
  formatCurrency: (n: number) => string;
  onConfirm: (picked: PickedCreditLine[]) => void;
}

export function InvoiceLineCreditPicker({
  open,
  onOpenChange,
  invoiceNumber,
  lines,
  isLoading,
  error,
  existing,
  formatCurrency,
  onConfirm,
}: Props) {
  const [selected, setSelected] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!open) return;
    const seed: Record<string, number> = {};
    for (const line of lines) {
      const already = existing?.[line.invoice_item_id];
      if (already != null) seed[line.invoice_item_id] = Math.min(already, line.invoiced_qty);
    }
    setSelected(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lines]);

  const allSelected =
    lines.length > 0 && lines.every((l) => selected[l.invoice_item_id] != null);

  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<string, number> = {};
    for (const l of lines) next[l.invoice_item_id] = selected[l.invoice_item_id] ?? l.invoiced_qty;
    setSelected(next);
  };

  const toggleLine = (line: CreditableInvoiceLine) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[line.invoice_item_id] != null) delete next[line.invoice_item_id];
      else next[line.invoice_item_id] = line.invoiced_qty;
      return next;
    });
  };

  const setQuantity = (line: CreditableInvoiceLine, value: number) => {
    const clamped = Math.max(0, Math.min(value, line.invoiced_qty));
    setSelected((prev) => ({ ...prev, [line.invoice_item_id]: clamped }));
  };

  const picked = useMemo(
    () =>
      lines
        .filter((l) => (selected[l.invoice_item_id] ?? 0) > 0)
        .map((l) => ({ line: l, quantity: selected[l.invoice_item_id] })),
    [lines, selected],
  );

  const pickedValue = picked.reduce((sum, p) => sum + p.quantity * p.line.net_unit_price, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Select invoice lines to credit</DialogTitle>
          <DialogDescription>
            {invoiceNumber
              ? `Lines from invoice ${invoiceNumber}. Prices carry the discount that was originally applied.`
              : "Prices carry the discount that was originally applied."}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <LoadingState rows={4} />
        ) : error ? (
          <p className="py-8 text-center text-sm text-destructive">{error}</p>
        ) : lines.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This invoice has no lines.
          </p>
        ) : (
          <ScrollArea className="max-h-[52vh] pr-3">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="w-10 py-2">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all invoice lines"
                    />
                  </th>
                  <th className="py-2 text-left font-medium">Item</th>
                  <th className="py-2 text-right font-medium">Invoiced</th>
                  <th className="py-2 text-right font-medium">Unit price</th>
                  <th className="w-32 py-2 text-right font-medium">Credit qty</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const checked = selected[line.invoice_item_id] != null;
                  return (
                    <tr key={line.invoice_item_id} className="border-b last:border-0">
                      <td className="py-2 align-top">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleLine(line)}
                          aria-label={`Select ${line.description}`}
                        />
                      </td>
                      <td className="py-2 pr-3 align-top">
                        <div className="font-medium">{line.description || "—"}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          {line.discount_percent > 0 && (
                            <Badge variant="outline" className="text-[10px]">
                              {line.discount_percent}% discount applied
                            </Badge>
                          )}
                          {line.tax_rate > 0 && (
                            <Badge variant="outline" className="text-[10px]">
                              Tax {line.tax_rate}%
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums align-top">
                        {line.invoiced_qty}
                      </td>
                      <td className="py-2 text-right tabular-nums align-top">
                        {formatCurrency(line.net_unit_price)}
                      </td>
                      <td className="py-2 pl-2 align-top">
                        <NumericInput
                          className="h-8"
                          value={selected[line.invoice_item_id] ?? 0}
                          disabled={!checked}
                          onValueChange={(v) => setQuantity(line, v ?? 0)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {picked.length} line{picked.length === 1 ? "" : "s"} selected ·{" "}
            {formatCurrency(pickedValue)} before tax
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={picked.length === 0}
              onClick={() => {
                onConfirm(picked);
                onOpenChange(false);
              }}
            >
              Add {picked.length > 0 ? `${picked.length} ` : ""}line
              {picked.length === 1 ? "" : "s"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
