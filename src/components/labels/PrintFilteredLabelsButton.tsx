/**
 * PrintFilteredLabelsButton — bulk labelling entry point for a product grid.
 *
 * Bulk label printing is a *server* operation. The browser never loops over
 * products: it submits the grid's current filter as a selection predicate and
 * the Label Operations engine expands it into `print_jobs` server-side. That
 * is what makes a 50,000-label run survivable — the tab can close, the run
 * resumes, and every line has a ledger row.
 */
import { useState } from "react";
import { Printer, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useLabelRunActions } from "@/hooks/inventory/useLabelRuns";
import type { PrinterWorkflow } from "@/services/printing/labelDispatch";

interface Props {
  /** Free-text filter currently applied to the grid. */
  search?: string | null;
  /** Category filter currently applied to the grid, if any. */
  categoryId?: string | null;
  /** Approximate number of rows the filter matches — shown for confirmation. */
  matchCount?: number | null;
  disabled?: boolean;
}

const TEMPLATES: { key: string; label: string; workflow: PrinterWorkflow }[] = [
  { key: "product_label", label: "Product label", workflow: "product_tag" },
  { key: "shelf_label", label: "Shelf edge label", workflow: "shelf_edge" },
];

export function PrintFilteredLabelsButton({
  search,
  categoryId,
  matchCount,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [templateKey, setTemplateKey] = useState(TEMPLATES[0].key);
  const [copies, setCopies] = useState(1);
  const [onlyWithBarcode, setOnlyWithBarcode] = useState(true);
  const navigate = useNavigate();
  const { currentBusiness } = useBusinesses();
  const { createRun } = useLabelRunActions(currentBusiness?.id ?? null);

  const template = TEMPLATES.find((t) => t.key === templateKey) ?? TEMPLATES[0];

  const submit = async () => {
    await createRun.mutateAsync({
      templateKey: template.key,
      workflow: template.workflow,
      entityType: "product",
      copies,
      selection: {
        kind: "product_filter",
        search: search?.trim() ? search.trim() : null,
        category_id: categoryId && categoryId !== "all" ? categoryId : null,
        is_active: true,
        only_with_barcode: onlyWithBarcode,
      },
      name: `${template.label} · filtered products`,
    });
    setOpen(false);
    navigate("/inventory-app/labels");
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={disabled}>
        <Printer className="mr-2 h-4 w-4" />
        Print labels
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Print labels for this selection</DialogTitle>
            <DialogDescription>
              The engine expands the current filter server-side and prints every matching
              product. You can close this page once the run is submitted.
              {typeof matchCount === "number" && (
                <> Roughly {matchCount} product{matchCount === 1 ? "" : "s"} match right now.</>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Label template</Label>
              <Select value={templateKey} onValueChange={setTemplateKey}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATES.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-32 space-y-1">
              <Label htmlFor="filtered-label-copies">Copies each</Label>
              <Input
                id="filtered-label-copies"
                type="number"
                min={1}
                max={20}
                value={copies}
                onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Only products with a scannable barcode</p>
                <p className="text-xs text-muted-foreground">
                  Items without a level identifier are refused rather than labelled with a
                  placeholder.
                </p>
              </div>
              <Switch checked={onlyWithBarcode} onCheckedChange={setOnlyWithBarcode} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={createRun.isPending}>
              {createRun.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Printer className="mr-2 h-4 w-4" />
              )}
              Submit run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
