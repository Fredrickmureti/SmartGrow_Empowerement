/**
 * LabelProductPicker — browse the catalogue and submit a label run from
 * inside Label Operations itself.
 *
 * Rationale: demand is the *automatic* half of labelling (price changed,
 * stock received). The deliberate half — "print shelf edges for these 40
 * items" — used to be reachable only from the Products grid, which forced
 * the operator out of the workspace that owns printing. This component
 * brings the same server-side run submission here: it never loops prints
 * client-side, it submits either explicit ids or the current filter as a
 * predicate the engine expands.
 */
import { useMemo, useState } from "react";
import { Printer, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useProductsPaginated } from "@/hooks/useProductsPaginated";
import { useProductCategories } from "@/hooks/useProductCategories";
import { useLabelRunActions } from "@/hooks/inventory/useLabelRuns";
import type { PrinterWorkflow } from "@/services/printing/labelDispatch";

const TEMPLATES: { key: string; label: string; workflow: PrinterWorkflow }[] = [
  { key: "product_label", label: "Product label", workflow: "product_tag" },
  { key: "shelf_label", label: "Shelf edge label", workflow: "shelf_edge" },
];

export function LabelProductPicker({ businessId }: { businessId: string | null }) {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [templateKey, setTemplateKey] = useState(TEMPLATES[1].key);
  const [copies, setCopies] = useState(1);
  const [onlyWithBarcode, setOnlyWithBarcode] = useState(true);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const { flatTreeList: categoryOptions } = useProductCategories();
  const filters = useMemo(
    () => ({ search: search.trim() || undefined, category_id: categoryFilter }),
    [search, categoryFilter],
  );
  const { products, isLoading, pagination, nextPage, previousPage } =
    useProductsPaginated(filters);
  const { createRun } = useLabelRunActions(businessId);

  const template = TEMPLATES.find((t) => t.key === templateKey) ?? TEMPLATES[0];
  const rows = products ?? [];
  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([k]) => k),
    [selected],
  );

  const submitSelected = () => {
    if (!selectedIds.length) return;
    createRun.mutate(
      {
        templateKey: template.key,
        workflow: template.workflow,
        entityType: "product",
        copies,
        name: `${template.label} — ${selectedIds.length} product${selectedIds.length === 1 ? "" : "s"}`,
        selection: { kind: "product_ids", ids: selectedIds },
      },
      { onSuccess: () => setSelected({}) },
    );
  };

  const submitFilter = () => {
    createRun.mutate({
      templateKey: template.key,
      workflow: template.workflow,
      entityType: "product",
      copies,
      name: `${template.label} — ${pagination.totalCount} matching product${pagination.totalCount === 1 ? "" : "s"}`,
      selection: {
        kind: "product_filter",
        search: search.trim() || null,
        category_id: categoryFilter !== "all" ? categoryFilter : null,
        is_active: true,
        only_with_barcode: onlyWithBarcode,
      },
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Print labels for existing products</CardTitle>
        <CardDescription>
          Pick items here instead of going to Products. Selected rows print as an explicit
          list; “Print all matching” submits the filter itself, so a whole category can be
          labelled without loading it into the browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label className="text-xs">Search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or SKU…"
                className="pl-8"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Category</Label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categoryOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Label</Label>
            <Select value={templateKey} onValueChange={setTemplateKey}>
              <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TEMPLATES.map((t) => (
                  <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Copies</Label>
            <Input
              type="number"
              min={1}
              max={99}
              value={copies}
              onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))}
              className="w-24"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <div className="flex items-center gap-3">
            <Switch
              id="label-picker-barcode"
              checked={onlyWithBarcode}
              onCheckedChange={setOnlyWithBarcode}
            />
            <Label htmlFor="label-picker-barcode" className="text-sm font-normal">
              Only products with a scannable barcode (applies to “Print all matching”)
            </Label>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!selectedIds.length || createRun.isPending}
              onClick={submitSelected}
            >
              Print selected ({selectedIds.length})
            </Button>
            <Button
              disabled={!pagination.totalCount || createRun.isPending}
              onClick={submitFilter}
            >
              {createRun.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Printer className="mr-2 h-4 w-4" />}
              Print all matching ({pagination.totalCount})
            </Button>
          </div>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={rows.length > 0 && rows.every((p) => selected[p.id])}
                    onCheckedChange={(c) =>
                      setSelected((s) => {
                        const next = { ...s };
                        rows.forEach((p) => { next[p.id] = !!c; });
                        return next;
                      })
                    }
                    aria-label="Select all on this page"
                  />
                </TableHead>
                <TableHead>Product</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No products match this filter.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Checkbox
                      checked={!!selected[p.id]}
                      onCheckedChange={(c) => setSelected((s) => ({ ...s, [p.id]: !!c }))}
                      aria-label={`Select ${p.name}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.sku ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{p.type ?? "product"}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {pagination.page} of {Math.max(pagination.totalPages, 1)} ·{" "}
            {pagination.totalCount} product{pagination.totalCount === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm" variant="outline"
              disabled={!pagination.hasPreviousPage}
              onClick={previousPage}
            >
              Previous
            </Button>
            <Button
              size="sm" variant="outline"
              disabled={!pagination.hasNextPage}
              onClick={nextPage}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default LabelProductPicker;
