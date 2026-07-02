import { useState, useCallback } from "react";
import {
  FieldDefinition,
  ValidatedRow,
  parseFile,
  autoMapColumns,
  validateRow,
  applyMapping,
} from "@/lib/importUtils";

export interface ImportResults {
  total: number;
  imported: number;
  skipped: number;
  errors: { rowIndex: number; data: Record<string, any>; errors: string }[];
}

export type BatchImportFn = (rows: Record<string, any>[]) => Promise<ImportResults>;

export function useImport(fieldDefinitions: FieldDefinition[]) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validatedRows, setValidatedRows] = useState<ValidatedRow[]>([]);
  const [results, setResults] = useState<ImportResults | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState(0);

  const reset = useCallback(() => {
    setStep(1);
    setFile(null);
    setHeaders([]);
    setRawRows([]);
    setMapping({});
    setValidatedRows([]);
    setResults(null);
    setIsImporting(false);
    setProgress(0);
  }, []);

  const handleFileUpload = useCallback(
    async (uploadedFile: File) => {
      setFile(uploadedFile);
      const { headers: parsedHeaders, rows } = await parseFile(uploadedFile);
      setHeaders(parsedHeaders);
      setRawRows(rows);
      const autoMapping = autoMapColumns(parsedHeaders, fieldDefinitions);
      setMapping(autoMapping);
      setStep(2);
    },
    [fieldDefinitions]
  );

  const updateMapping = useCallback((header: string, fieldKey: string) => {
    setMapping((prev) => ({ ...prev, [header]: fieldKey }));
  }, []);

  const goToPreview = useCallback(() => {
    const validated = rawRows.map((row, index) => ({
      data: row,
      errors: validateRow(row, fieldDefinitions, mapping),
      rowIndex: index + 2, // +2 for 1-indexed header row
    }));
    setValidatedRows(validated);
    setStep(3);
  }, [rawRows, fieldDefinitions, mapping]);

  const executeImport = useCallback(
    async (onImport: (row: Record<string, any>) => Promise<any>) => {
      setIsImporting(true);
      const validRows = validatedRows.filter((r) => r.errors.length === 0);
      const importResults: ImportResults = {
        total: rawRows.length,
        imported: 0,
        skipped: validatedRows.filter((r) => r.errors.length > 0).length,
        errors: [],
      };

      // Add pre-validation errors
      for (const row of validatedRows.filter((r) => r.errors.length > 0)) {
        importResults.errors.push({
          rowIndex: row.rowIndex,
          data: row.data,
          errors: row.errors.map((e) => e.message).join("; "),
        });
      }

      // Process in chunks of 50
      const CHUNK_SIZE = 50;
      for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
        const chunk = validRows.slice(i, i + CHUNK_SIZE);

        for (const row of chunk) {
          try {
            const mappedData = applyMapping(row.data, mapping, fieldDefinitions);
            await onImport(mappedData);
            importResults.imported++;
          } catch (error: any) {
            importResults.errors.push({
              rowIndex: row.rowIndex,
              data: row.data,
              errors: error.message || "Unknown error",
            });
          }
        }

        setProgress(Math.round(((i + chunk.length) / validRows.length) * 100));
      }

      setResults(importResults);
      setIsImporting(false);
      setStep(4);
    },
    [validatedRows, rawRows.length, mapping, fieldDefinitions]
  );

  const executeBatchImport = useCallback(
    async (onBatchImport: BatchImportFn) => {
      setIsImporting(true);
      setProgress(10);

      try {
        const validRows = validatedRows.filter((r) => r.errors.length === 0);
        const mappedRows = validRows.map((row) =>
          applyMapping(row.data, mapping, fieldDefinitions)
        );

        setProgress(30);
        const batchResults = await onBatchImport(mappedRows);

        // Merge pre-validation errors into batch results
        const preValidationErrors = validatedRows
          .filter((r) => r.errors.length > 0)
          .map((row) => ({
            rowIndex: row.rowIndex,
            data: row.data,
            errors: row.errors.map((e) => e.message).join("; "),
          }));

        const finalResults: ImportResults = {
          total: rawRows.length,
          imported: batchResults.imported,
          skipped: batchResults.skipped + preValidationErrors.length,
          errors: [...preValidationErrors, ...batchResults.errors],
        };

        setResults(finalResults);
      } catch (error: any) {
        setResults({
          total: rawRows.length,
          imported: 0,
          skipped: rawRows.length,
          errors: [{ rowIndex: 0, data: {}, errors: error.message || "Batch import failed" }],
        });
      }

      setProgress(100);
      setIsImporting(false);
      setStep(4);
    },
    [validatedRows, rawRows.length, mapping, fieldDefinitions]
  );

  return {
    step,
    file,
    headers,
    rawRows,
    mapping,
    validatedRows,
    results,
    isImporting,
    progress,
    reset,
    handleFileUpload,
    updateMapping,
    goToPreview,
    executeImport,
    executeBatchImport,
    setStep,
  };
}
