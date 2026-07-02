import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface EmployeeDocument {
  id: string;
  organization_id: string;
  employee_id: string;
  document_type: string;
  name: string;
  description: string | null;
  file_path: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  uploaded_by: string | null;
  expiry_date: string | null;
  is_verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export const DOCUMENT_TYPES = [
  { value: "contract", label: "Employment Contract" },
  { value: "id_copy", label: "ID / Passport Copy" },
  { value: "cv", label: "CV / Resume" },
  { value: "certificate", label: "Certificate" },
  { value: "offer_letter", label: "Offer Letter" },
  { value: "tax_document", label: "Tax Document" },
  { value: "medical", label: "Medical Record" },
  { value: "disciplinary", label: "Disciplinary Record" },
  { value: "performance", label: "Performance Review" },
  { value: "other", label: "Other" },
];

export function useEmployeeDocuments(employeeId: string | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ["employee-documents", employeeId, currentOrg?.id],
    queryFn: async () => {
      if (!employeeId || !currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("employee_documents")
        .select("*")
        .eq("employee_id", employeeId)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as EmployeeDocument[];
    },
    enabled: !!employeeId && !!currentOrg?.id,
  });

  const uploadDocument = useMutation({
    mutationFn: async ({ file, documentType, name, description }: {
      file: File; documentType: string; name: string; description?: string;
    }) => {
      if (!employeeId || !currentOrg?.id) throw new Error("Missing context");

      const filePath = `${currentOrg.id}/${employeeId}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("employee-documents")
        .upload(filePath, file);
      if (uploadError) throw uploadError;

      const { data, error } = await supabase
        .from("employee_documents")
        .insert({
          organization_id: currentOrg.id,
        business_id: currentBusiness.id,
          employee_id: employeeId,
          document_type: documentType,
          name,
          description: description || null,
          file_path: filePath,
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["employee-documents", employeeId] });
      toast.success("Document uploaded successfully");
    },
    onError: (err: any) => toast.error(`Upload failed: ${normalizeError(err).message}`),
  });

  const deleteDocument = useMutation({
    mutationFn: async (doc: EmployeeDocument) => {
      if (doc.file_path) {
        await supabase.storage.from("employee-documents").remove([doc.file_path]);
      }
      const { error } = await supabase.from("employee_documents").delete().eq("id", doc.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["employee-documents", employeeId] });
      toast.success("Document deleted");
    },
    onError: (err: any) => toast.error(`Delete failed: ${normalizeError(err).message}`),
  });

  const downloadDocument = async (doc: EmployeeDocument) => {
    if (!doc.file_path) return;
    const { data, error } = await supabase.storage
      .from("employee-documents")
      .download(doc.file_path);
    if (error) { toast.error("Download failed"); return; }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.file_name || doc.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getPreviewUrl = async (doc: EmployeeDocument): Promise<string | null> => {
    if (!doc.file_path) return null;
    const { data, error } = await supabase.storage
      .from("employee-documents")
      .createSignedUrl(doc.file_path, 3600); // 1 hour
    if (error) { toast.error("Failed to generate preview URL"); return null; }
    return data.signedUrl;
  };

  return { documents, isLoading, uploadDocument, deleteDocument, downloadDocument, getPreviewUrl };
}
