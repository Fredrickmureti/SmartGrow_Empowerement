/**
 * useMyDocuments — self-service hook for `/me/documents`.
 *
 * Lists the signed-in employee's own `employee_documents` rows (RLS already
 * scopes via `e.user_id = auth.uid()`) and exposes:
 *  - `download(doc)` — opens a signed URL to the underlying storage object
 *  - `acknowledge(id)` — calls the `acknowledge_employee_document` RPC,
 *    which is the only path an employee has for writing to the row
 *    (no column-restricted RLS UPDATE policy exists, by design).
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { toast } from "sonner";

export interface MyDocument {
  id: string;
  document_type: string | null;
  name: string;
  description: string | null;
  file_path: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  expiry_date: string | null;
  is_verified: boolean | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

const DOCUMENTS_BUCKET = "employee-documents";

export function useMyDocuments() {
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const [documents, setDocuments] = useState<MyDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchDocuments = useCallback(async () => {
    if (!currentEmployee?.id) {
      setDocuments([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const { data, error } = await supabase
      .from("employee_documents")
      .select(
        "id, document_type, name, description, file_path, file_name, file_size, mime_type, expiry_date, is_verified, acknowledged_at, acknowledged_by, created_at",
      )
      .eq("employee_id", currentEmployee.id)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[useMyDocuments] fetch failed", error);
      setDocuments([]);
    } else {
      setDocuments((data as MyDocument[]) ?? []);
    }
    setIsLoading(false);
  }, [currentEmployee?.id]);

  useEffect(() => {
    if (!empLoading) fetchDocuments();
  }, [empLoading, fetchDocuments]);

  const download = useCallback(async (doc: MyDocument) => {
    if (!doc.file_path) {
      toast.error("This document has no file attached.");
      return;
    }
    const { data, error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(doc.file_path, 60);
    if (error || !data?.signedUrl) {
      toast.error(error?.message || "Could not generate download link.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }, []);

  const acknowledge = useCallback(async (id: string) => {
    const { data, error } = await supabase.rpc(
      "acknowledge_employee_document" as never,
      { _document_id: id } as never,
    );
    if (error) {
      toast.error(error.message || "Could not acknowledge document.");
      return false;
    }
    toast.success("Document acknowledged.");
    // Merge the returned row into local state.
    const row = data as MyDocument | null;
    if (row?.id) {
      setDocuments((prev) => prev.map((d) => (d.id === row.id ? { ...d, ...row } : d)));
    } else {
      await fetchDocuments();
    }
    return true;
  }, [fetchDocuments]);

  return {
    documents,
    isLoading: empLoading || isLoading,
    refresh: fetchDocuments,
    download,
    acknowledge,
  };
}