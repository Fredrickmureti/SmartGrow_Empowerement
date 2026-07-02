import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useImport, BatchImportFn } from "@/hooks/useImport";
import { FieldDefinition, downloadTemplate, downloadErrorReport } from "@/lib/importUtils";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  Download,
  ArrowLeft,
  ArrowRight,
  Loader2,
  AlertTriangle,
} from "lucide-react";

interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityName: string;
  fieldDefinitions: FieldDefinition[];
  onImport: (row: Record<string, any>) => Promise<any>;
  onBatchImport?: BatchImportFn;
  onComplete?: () => void;
}

export function ImportWizard({
  open,
  onOpenChange,
  entityName,
  fieldDefinitions,
  onImport,
  onBatchImport,
  onComplete,
}: ImportWizardProps) {
  const importState = useImport(fieldDefinitions);

  const handleClose = () => {
    importState.reset();
    onOpenChange(false);
    if (importState.step === 4 && onComplete) {
      onComplete();
    }
  };

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        try {
          await importState.handleFileUpload(acceptedFiles[0]);
        } catch (error: any) {
          // Will show in toast from parent
          console.error("File parse error:", error);
        }
      }
    },
    [importState.handleFileUpload]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "text/csv": [".csv"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel": [".xls"],
    },
    maxFiles: 1,
  });

  const validCount = importState.validatedRows.filter((r) => r.errors.length === 0).length;
  const errorCount = importState.validatedRows.filter((r) => r.errors.length > 0).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-2xl max-h-[85vh] overflow-y-auto p-3 sm:p-6">
        <DialogHeader>
          <DialogTitle>Import {entityName}s</DialogTitle>
          <DialogDescription>
            {importState.step === 1 && "Upload a CSV or Excel file to import records."}
            {importState.step === 2 && "Map your file columns to the correct fields."}
            {importState.step === 3 && "Review your data before importing."}
            {importState.step === 4 && "Import complete."}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicators */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center gap-1">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                  s === importState.step
                    ? "bg-primary text-primary-foreground"
                    : s < importState.step
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {s}
              </div>
              <span className="hidden sm:inline">
                {s === 1 && "Upload"}
                {s === 2 && "Map"}
                {s === 3 && "Preview"}
                {s === 4 && "Results"}
              </span>
              {s < 4 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
            </div>
          ))}
        </div>

        {/* Step 1: Upload */}
        {importState.step === 1 && (
          <div className="space-y-4">
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                isDragActive
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-primary/50"
              }`}
            >
              <input {...getInputProps()} />
              <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">
                {isDragActive ? "Drop file here" : "Drag & drop a file here, or click to browse"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Supports CSV, XLSX, and XLS files
              </p>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadTemplate(entityName, fieldDefinitions)}
              className="w-full"
            >
              <Download className="mr-2 h-4 w-4" />
              Download Template
            </Button>
          </div>
        )}

        {/* Step 2: Column Mapping */}
        {importState.step === 2 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{importState.file?.name}</span>
              <span className="text-muted-foreground">
                ({importState.rawRows.length} rows)
              </span>
            </div>

            <div className="space-y-2 max-h-[40vh] overflow-y-auto">
              {importState.headers.map((header) => (
                <div key={header} className="flex items-center gap-2 sm:gap-3">
                  <span className="text-sm w-1/3 truncate font-medium" title={header}>
                    {header}
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <Select
                    value={importState.mapping[header] || "__skip__"}
                    onValueChange={(val) =>
                      importState.updateMapping(header, val === "__skip__" ? "" : val)
                    }
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__skip__">— Skip —</SelectItem>
                      {fieldDefinitions.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label}
                          {field.required && " *"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="flex justify-between">
              <Button variant="outline" size="sm" onClick={() => importState.setStep(1)}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button size="sm" onClick={importState.goToPreview}>
                Preview
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {importState.step === 3 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm">
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {validCount} ready
              </Badge>
              {errorCount > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="h-3 w-3" />
                  {errorCount} errors
                </Badge>
              )}
            </div>

            <div className="max-w-full overflow-x-auto overflow-y-auto rounded-lg border [overscroll-behavior-x:contain] [-webkit-overflow-scrolling:touch]">
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead className="w-16">Status</TableHead>
                    {importState.headers
                      .filter((h) => importState.mapping[h])
                      .slice(0, 5)
                      .map((h) => (
                        <TableHead key={h} className="text-xs">
                          {fieldDefinitions.find((f) => f.key === importState.mapping[h])?.label ||
                            h}
                        </TableHead>
                      ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importState.validatedRows.slice(0, 10).map((row) => (
                    <TableRow key={row.rowIndex}>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.rowIndex}
                      </TableCell>
                      <TableCell>
                        {row.errors.length === 0 ? (
                          <CheckCircle2 className="h-4 w-4 text-primary" />
                        ) : (
                          <div className="group relative">
                            <XCircle className="h-4 w-4 text-destructive" />
                            <div className="absolute left-0 bottom-full mb-1 hidden group-hover:block bg-popover border rounded p-2 text-xs max-w-xs z-50 shadow-md">
                              {row.errors.map((e, i) => (
                                <div key={i}>
                                  {e.field}: {e.message}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </TableCell>
                      {importState.headers
                        .filter((h) => importState.mapping[h])
                        .slice(0, 5)
                        .map((h) => (
                          <TableCell key={h} className="text-xs max-w-[120px] truncate">
                            {row.data[h]}
                          </TableCell>
                        ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {importState.validatedRows.length > 10 && (
              <p className="text-xs text-muted-foreground">
                Showing first 10 of {importState.validatedRows.length} rows
              </p>
            )}

            {importState.isImporting ? (
              <div className="space-y-2">
                <Progress value={importState.progress} className="h-2" />
                <p className="text-xs text-muted-foreground text-center">
                  Importing... {importState.progress}%
                </p>
              </div>
            ) : (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                <Button variant="outline" size="sm" onClick={() => importState.setStep(2)}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </Button>
                <Button
                  size="sm"
                  onClick={() => onBatchImport 
                    ? importState.executeBatchImport(onBatchImport) 
                    : importState.executeImport(onImport)
                  }
                  disabled={validCount === 0}
                >
                  Import {validCount} {entityName}{validCount !== 1 ? "s" : ""}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Results */}
        {importState.step === 4 && importState.results && (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center gap-2">
                {importState.results.errors.length === 0 ? (
                  <CheckCircle2 className="h-5 w-5 text-primary" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                )}
                <span className="font-medium">Import Complete</span>
              </div>

              <div className="grid grid-cols-3 gap-4 text-center text-sm">
                <div>
                    <div className="text-2xl font-bold text-primary">
                    {importState.results.imported}
                  </div>
                  <div className="text-muted-foreground">Imported</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-destructive">
                    {importState.results.errors.length}
                  </div>
                  <div className="text-muted-foreground">Failed</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-muted-foreground">
                    {importState.results.total}
                  </div>
                  <div className="text-muted-foreground">Total</div>
                </div>
              </div>
            </div>

            {importState.results.errors.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => downloadErrorReport(importState.results!.errors)}
              >
                <Download className="mr-2 h-4 w-4" />
                Download Error Report
              </Button>
            )}

            <Button className="w-full" onClick={handleClose}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
