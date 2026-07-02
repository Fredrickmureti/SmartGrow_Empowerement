import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useMigrationSession } from "@/hooks/useMigrationSession";
import { useMigrationFileUpload } from "@/hooks/useMigrationFileUpload";
import { useMigrationImportLoop } from "@/hooks/useMigrationImportLoop";
import { createEntityMatcher } from "@/lib/migration/entityMatcher";
import {
  autoMapMigrationColumns,
  getMappedValue,
  validateMappedRow,
  INVENTORY_FIELDS,
} from "@/lib/migration/columnMapper";
import { downloadTemplate } from "@/lib/migration/csvTemplates";
import { useToast } from "@/hooks/use-toast";
import { Upload, FileSpreadsheet, Loader2, Info, AlertTriangle, Download } from "lucide-react";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

interface InventoryRow {
  productName: string;
  sku: string;
  quantity: number;
  unitCost: number;
  totalValue: number;
  matchedProductId?: string;
  status: "matched" | "unmatched";
  validationErrors?: string[];
}

export function MigrationStepInventory({ onComplete, onSkip }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const migration = useMigrationSession();
  const [parsedRows, setParsedRows] = useState<InventoryRow[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<number>(0);

  const fileUpload = useMigrationFileUpload({
    isBatchDuplicate: migration.isBatchDuplicate,
    allowRetry: true,
    onParsed: useCallback(async ({ headers, rows }) => {
      // Use shared column mapper
      const mapping = autoMapMigrationColumns(headers, INVENTORY_FIELDS, "inventory");

      const { fetchAllRows } = await import("@/lib/supabasePagination");
      const products = await fetchAllRows<{ id: string; name: string; sku: string | null }>(
        "products",
        "id, name, sku",
        [
          { method: "eq", column: "organization_id", value: currentOrg!.id },
          { method: "eq", column: "is_active", value: true },
        ]
      );

      // Use shared entity matcher with fuzzy support
      const matcher = createEntityMatcher(products, {
        primaryKey: (p) => p.sku || "",
        secondaryKey: (p) => p.name,
        fuzzyMatch: true,
        fuzzyThreshold: 0.7,
      });

      let warningCount = 0;

      const parsed: InventoryRow[] = rows
        .filter(row => {
          const name = getMappedValue(row, "product_name", mapping, INVENTORY_FIELDS);
          const sku = getMappedValue(row, "sku", mapping, INVENTORY_FIELDS);
          return (name && (name as string).trim()) || (sku && (sku as string).trim());
        })
        .map(row => {
          // Pre-import validation
          const errors = validateMappedRow(row, mapping, INVENTORY_FIELDS);
          if (errors.length > 0) warningCount++;

          const name = (getMappedValue(row, "product_name", mapping, INVENTORY_FIELDS) as string) || "";
          const sku = (getMappedValue(row, "sku", mapping, INVENTORY_FIELDS) as string) || "";
          const qty = Math.abs((getMappedValue(row, "quantity", mapping, INVENTORY_FIELDS) as number) || 0);
          const cost = Math.abs((getMappedValue(row, "unit_cost", mapping, INVENTORY_FIELDS) as number) || 0);
          const totalVal = (getMappedValue(row, "total_value", mapping, INVENTORY_FIELDS) as number);
          const total = totalVal !== null ? Math.abs(totalVal) : qty * cost;

          const matchResult = matcher.match(sku || undefined, name || undefined);

          return {
            productName: name,
            sku,
            quantity: qty,
            unitCost: cost,
            totalValue: total,
            matchedProductId: matchResult?.item.id,
            status: matchResult ? "matched" as const : "unmatched" as const,
            validationErrors: errors.length > 0 ? errors : undefined,
          };
        });

      setValidationWarnings(warningCount);
      setParsedRows(parsed);
    }, [currentOrg]),
  });

  const importLoop = useMigrationImportLoop({
    recordBatch: migration.recordBatch,
    updateStepStatus: migration.updateStepStatus,
  });

  const matchedRows = parsedRows.filter(r => r.status === "matched");
  const unmatchedRows = parsedRows.filter(r => r.status === "unmatched");
  const totalValue = matchedRows.reduce((s, r) => s + r.totalValue, 0);
  const totalQty = matchedRows.reduce((s, r) => s + r.quantity, 0);

  const handleImport = async () => {
    if (!currentOrg?.id || !currentBusiness?.id || !fileUpload.file || !user) return;
    const cutoverDate = migration.session?.cutover_date || new Date().toISOString().slice(0, 10);
    const importable = matchedRows.filter(r => r.matchedProductId && r.quantity > 0);

    // Resolve a warehouse for this company. Opening-stock movements MUST land
    // in a real (business, branch)-scoped warehouse; the silent default-fallback
    // trigger has been removed (see migration: inventory hardening Phase A.6).
    // We also need the warehouse's branch_id — stock_movements.branch_id is
    // NOT NULL and must agree with the warehouse (enforced by trigger).
    const { data: wh, error: whErr } = await supabase
      .from("warehouses")
      .select("id, branch_id")
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (whErr || !wh) {
      toast({
        title: "No warehouse found",
        description: "Create a warehouse for this company before importing opening stock.",
        variant: "destructive",
      });
      return;
    }
    if (!wh.branch_id) {
      toast({
        title: "Warehouse missing branch",
        description: "The default warehouse has no branch assigned. Edit it before importing.",
        variant: "destructive",
      });
      return;
    }
    const warehouseId = wh.id;
    const warehouseBranchId = wh.branch_id;

    await importLoop.executeLoop({
      stepKey: "inventory",
      fileHash: fileUpload.fileHash,
      fileName: fileUpload.file.name,
      totalRows: parsedRows.length,
      matchedRows: importable,
      unmatchedCount: unmatchedRows.length,
      chunkSize: 100,
      batchInsert: async (chunk) => {
        const inserts = chunk.map(row => ({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: warehouseBranchId,
          warehouse_id: warehouseId,
          product_id: row.matchedProductId!,
          movement_type: "opening",
          quantity: row.quantity,
          unit_cost: row.unitCost,
          movement_date: cutoverDate,
          notes: "Migration: Opening inventory stock",
          created_by: user.id,
          migration_session_id: migration.session?.id || null,
        }));

        const { data, error } = await supabase.from("stock_movements").insert(inserts).select("id");
        if (error) throw error;
        return { imported: data?.length || 0, errors: [] };
      },
      importRow: async (row) => {
        const { error } = await supabase
          .from("stock_movements")
          .insert({
            organization_id: currentOrg.id,
            business_id: currentBusiness.id,
            branch_id: warehouseBranchId,
            warehouse_id: warehouseId,
            product_id: row.matchedProductId!,
            movement_type: "opening",
            quantity: row.quantity,
            unit_cost: row.unitCost,
            movement_date: cutoverDate,
            notes: "Migration: Opening inventory stock",
            created_by: user.id,
            migration_session_id: migration.session?.id || null,
          });
        if (error) throw error;
      },
      getRowLabel: (row) => row.sku || row.productName,
      onSuccess: onComplete,
      successMessage: "Inventory imported",
      successDescription: `${importable.length} stock movements created (${totalQty} units, ${totalValue.toLocaleString()} value).`,
    });
  };

  const handleReset = () => {
    fileUpload.reset();
    setParsedRows([]);
    setValidationWarnings(0);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Inventory Opening Stock</CardTitle>
          <Button variant="outline" size="sm" onClick={() => downloadTemplate("inventory")}>
            <Download className="mr-2 h-4 w-4" /> Template
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Import opening stock quantities and values. These create stock movement records for inventory tracking.
          The GL balance was already posted via the Trial Balance step.
        </p>

        {parsedRows.length === 0 ? (
          <>
            <div
              {...fileUpload.dropzone.getRootProps()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${fileUpload.dropzone.isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
            >
              <input {...fileUpload.dropzone.getInputProps()} />
              {fileUpload.isProcessing ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm">Processing file...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">Drop CSV or XLSX file here</p>
                  <p className="text-xs text-muted-foreground">
                    Columns: Product Name, SKU, Quantity, Unit Cost, Total Value
                  </p>
                </div>
              )}
            </div>
            <Button variant="ghost" onClick={onSkip} className="w-full">Skip this step</Button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4" />
              <span className="font-medium">{fileUpload.file?.name}</span>
              <Button variant="ghost" size="sm" onClick={handleReset}>Change file</Button>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold">{parsedRows.length}</div>
                <div className="text-xs text-muted-foreground">Total Rows</div>
              </div>
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold text-success">{matchedRows.length}</div>
                <div className="text-xs text-muted-foreground">Matched</div>
              </div>
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold">{totalQty.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Total Units</div>
              </div>
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold">{totalValue.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Total Value</div>
              </div>
            </div>

            {validationWarnings > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {validationWarnings} row(s) have validation warnings (missing required fields or invalid values).
                </AlertDescription>
              </Alert>
            )}

            {unmatchedRows.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {unmatchedRows.length} product(s) not found: {unmatchedRows.slice(0, 3).map(r => r.sku || r.productName).join(", ")}
                  {unmatchedRows.length > 3 && ` and ${unmatchedRows.length - 3} more`}
                </AlertDescription>
              </Alert>
            )}

            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                Stock movements are for inventory quantity tracking. The inventory GL balance was already included in your Trial Balance import.
              </AlertDescription>
            </Alert>

            {importLoop.progress && (
              <div className="text-sm text-muted-foreground text-center">
                Importing... {importLoop.progress.current} / {importLoop.progress.total}
              </div>
            )}

            <div className="max-h-64 overflow-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit Cost</TableHead>
                    <TableHead className="text-right">Total Value</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.slice(0, 50).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{row.productName}</TableCell>
                      <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                      <TableCell className="text-right text-sm">{row.quantity.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm">{row.unitCost.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm">{row.totalValue.toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge variant={row.status === "matched" ? "default" : "destructive"} className="text-xs">{row.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {importLoop.lastErrors.length > 0 && (
              <Button variant="outline" size="sm" onClick={importLoop.downloadErrors}>
                <Download className="mr-2 h-4 w-4" /> Download Error Report
              </Button>
            )}

            <div className="flex gap-2">
              <Button onClick={handleImport} disabled={matchedRows.length === 0 || importLoop.isImporting} className="flex-1">
                {importLoop.isImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import {matchedRows.length} Stock Items
              </Button>
              <Button variant="ghost" onClick={onSkip}>Skip</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
