import { useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import type { StepKey } from "@/lib/migration/types";
import { downloadErrorReport } from "@/lib/importUtils";
import { normalizeError } from "@/services/resilience";

interface ImportLoopOptions {
  /** The migration session hook — needs recordBatch and updateStepStatus */
  recordBatch: (params: {
    stepKey: StepKey;
    batchHash: string;
    sourceFileName?: string;
    recordsTotal: number;
    recordsImported: number;
    recordsFailed: number;
    errorDetails?: any[];
  }) => Promise<void>;
  updateStepStatus: (
    stepKey: StepKey,
    status: "completed" | "failed",
    extra?: { record_count?: number; error_count?: number; error_log?: any[] }
  ) => Promise<void>;
}

/**
 * Shared hook for migration stage import execution.
 * Supports both row-by-row and chunked batch import modes.
 * Handles: importing state, error collection, batch recording,
 * step status update, toast notifications, and downloadable error reports.
 */
export function useMigrationImportLoop({ recordBatch, updateStepStatus }: ImportLoopOptions) {
  const { toast } = useToast();
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [lastErrors, setLastErrors] = useState<any[]>([]);

  /**
   * Execute an import loop over matched rows.
   * Supports chunked batch processing when batchInsert is provided.
   */
  const executeLoop = useCallback(
    async <T>(params: {
      stepKey: StepKey;
      fileHash: string;
      fileName: string;
      totalRows: number;
      matchedRows: T[];
      unmatchedCount: number;
      /** Import a single row. Throw on failure. Used when batchInsert is not provided. */
      importRow?: (row: T, index: number) => Promise<void>;
      /** Batch import a chunk of rows. Returns { imported, errors }. */
      batchInsert?: (chunk: T[]) => Promise<{ imported: number; errors: Array<{ item: string; error: string }> }>;
      /** Chunk size for batch processing (default 100) */
      chunkSize?: number;
      getRowLabel: (row: T) => string;
      onSuccess?: () => void;
      successMessage?: string;
      successDescription?: string;
      extraErrorDetails?: any[];
    }) => {
      setIsImporting(true);
      setProgress({ current: 0, total: params.matchedRows.length });
      setLastErrors([]);

      try {
        let imported = 0;
        const errors: any[] = [];
        const chunkSize = params.chunkSize ?? 100;

        if (params.batchInsert) {
          // Chunked batch processing
          for (let i = 0; i < params.matchedRows.length; i += chunkSize) {
            const chunk = params.matchedRows.slice(i, i + chunkSize);
            try {
              const result = await params.batchInsert(chunk);
              imported += result.imported;
              errors.push(...result.errors);
            } catch (err: any) {
              // Chunk-level failure: fall back to row-by-row for this chunk
              if (params.importRow) {
                for (const row of chunk) {
                  try {
                    await params.importRow(row, i);
                    imported++;
                  } catch (rowErr: any) {
                    errors.push({ item: params.getRowLabel(row), error: rowErr.message });
                  }
                }
              } else {
                errors.push({ item: `chunk-${i}`, error: err.message });
              }
            }
            setProgress({ current: Math.min(i + chunkSize, params.matchedRows.length), total: params.matchedRows.length });
          }
        } else if (params.importRow) {
          // Row-by-row processing (legacy fallback)
          for (let i = 0; i < params.matchedRows.length; i++) {
            const row = params.matchedRows[i];
            try {
              await params.importRow(row, i);
              imported++;
              setProgress({ current: i + 1, total: params.matchedRows.length });
            } catch (err: any) {
              errors.push({
                item: params.getRowLabel(row),
                error: err.message,
              });
            }
          }
        }

        setLastErrors(errors);

        await recordBatch({
          stepKey: params.stepKey,
          batchHash: params.fileHash,
          sourceFileName: params.fileName,
          recordsTotal: params.totalRows,
          recordsImported: imported,
          recordsFailed: errors.length + params.unmatchedCount,
          errorDetails: [...(params.extraErrorDetails || []), ...errors],
        });

        await updateStepStatus(params.stepKey, "completed", {
          record_count: imported,
          error_count: errors.length + params.unmatchedCount,
        });

        toast({
          title: params.successMessage || "Import complete",
          description: params.successDescription ||
            `${imported} records imported. ${params.unmatchedCount} unmatched rows skipped.${errors.length > 0 ? ` ${errors.length} errors.` : ""}`,
        });

        params.onSuccess?.();
        return { imported, errors };
      } catch (err: any) {
        toast({ title: "Import failed", description: normalizeError(err).message, variant: "destructive" });
        return { imported: 0, errors: [{ item: "batch", error: err.message }] };
      } finally {
        setIsImporting(false);
        setProgress(null);
      }
    },
    [recordBatch, updateStepStatus, toast]
  );

  /** Download the last import's errors as a CSV report */
  const downloadErrors = useCallback(() => {
    if (lastErrors.length === 0) return;
    downloadErrorReport(
      lastErrors.map((e, i) => ({
        rowIndex: i,
        data: { item: e.item || `Row ${i}` },
        errors: e.error || "Unknown error",
      }))
    );
  }, [lastErrors]);

  return { isImporting, progress, executeLoop, lastErrors, downloadErrors };
}
