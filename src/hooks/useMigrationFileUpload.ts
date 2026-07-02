import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { parseFile } from "@/lib/importUtils";
import { hashFileContent } from "@/lib/migration/hashUtils";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface UseMigrationFileUploadOptions {
  /** The migration session hook instance (must have isBatchDuplicate) */
  isBatchDuplicate: (hash: string) => Promise<boolean>;
  /** Called after successful parse with headers, rows, file, and hash */
  onParsed: (result: {
    headers: string[];
    rows: Record<string, string>[];
    file: File;
    fileHash: string;
  }) => void;
  /**
   * When true, allow re-uploading a file with the same hash (for retry after partial failure).
   * Default: false (blocks duplicate files).
   */
  allowRetry?: boolean;
}

/**
 * Shared hook for migration stage file upload.
 * Handles: dropzone setup, file parsing via shared parseFile(),
 * SHA-256 hashing, and idempotency (duplicate batch check).
 *
 * Set allowRetry=true to permit re-importing the same file
 * (e.g., after a partial failure where the user wants to retry).
 */
export function useMigrationFileUpload({ isBatchDuplicate, onParsed, allowRetry = false }: UseMigrationFileUploadOptions) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDuplicate, setIsDuplicate] = useState(false);

  const onDrop = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const f = files[0];
      setFile(f);
      setIsProcessing(true);
      setIsDuplicate(false);

      try {
        const hash = await hashFileContent(f);
        const duplicate = await isBatchDuplicate(hash);
        if (duplicate && !allowRetry) {
          setIsDuplicate(true);
          toast({ title: "This file was already imported", variant: "destructive" });
          setIsProcessing(false);
          return;
        }

        if (duplicate && allowRetry) {
          toast({
            title: "File previously imported",
            description: "Retrying import with the same file. Previously imported records will be checked.",
          });
        }

        setFileHash(hash);
        const { headers, rows } = await parseFile(f);
        await onParsed({ headers, rows, file: f, fileHash: hash });
      } catch (err: any) {
        toast({ title: "Error parsing file", description: normalizeError(err).message, variant: "destructive" });
      }
      setIsProcessing(false);
    },
    [isBatchDuplicate, onParsed, toast, allowRetry]
  );

  const dropzone = useDropzone({
    onDrop,
    accept: {
      "text/csv": [".csv"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    },
    maxFiles: 1,
  });

  const reset = useCallback(() => {
    setFile(null);
    setFileHash("");
    setIsDuplicate(false);
  }, []);

  return {
    file,
    fileHash,
    isProcessing,
    isDuplicate,
    dropzone,
    reset,
  };
}
