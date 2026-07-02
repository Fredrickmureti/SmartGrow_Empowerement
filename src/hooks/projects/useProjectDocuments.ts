/**
 * useProjectDocuments — list/upload/delete project documents
 *
 * Storage bucket: `project-documents` with path convention
 *   {organization_id}/{project_id}/{filename}
 * RLS on storage.objects mirrors can_access_project.
 *
 * `project_documents` table holds metadata (display name, uploader, mime, size).
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface ProjectDocument {
  id: string;
  project_id: string;
  organization_id: string;
  name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
}

export function useProjectDocuments(projectId: string | null | undefined) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("project_documents")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setDocuments((data || []) as ProjectDocument[]);
    } catch (e) {
      console.error("useProjectDocuments.refresh", e);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async (file: File) => {
    if (!projectId || !currentOrg || !user) {
      throw new Error("Missing project or organization context");
    }
    const safe = file.name.replace(/[^\w.\-]+/g, "_");
    const path = `${currentOrg.id}/${projectId}/${Date.now()}_${safe}`;

    const { error: upErr } = await supabase.storage
      .from("project-documents")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) {
      toast.error(`Upload failed: ${upErr.message}`);
      throw upErr;
    }

    const { error: insErr } = await supabase.from("project_documents").insert({
      project_id: projectId,
      organization_id: currentOrg.id,
      name: file.name,
      storage_path: path,
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: user.id,
    } as never);
    if (insErr) {
      // Best-effort cleanup of orphan file
      await supabase.storage.from("project-documents").remove([path]);
      toast.error("Failed to record document");
      throw insErr;
    }
    toast.success("Document uploaded");
    await refresh();
  };

  const remove = async (doc: ProjectDocument) => {
    const { error: dbErr } = await supabase
      .from("project_documents")
      .delete()
      .eq("id", doc.id);
    if (dbErr) {
      toast.error("Failed to delete document");
      return;
    }
    await supabase.storage.from("project-documents").remove([doc.storage_path]);
    toast.success("Document deleted");
    await refresh();
  };

  const getSignedUrl = async (doc: ProjectDocument): Promise<string | null> => {
    const { data, error } = await supabase.storage
      .from("project-documents")
      .createSignedUrl(doc.storage_path, 60 * 5);
    if (error) {
      toast.error("Could not generate download link");
      return null;
    }
    return data.signedUrl;
  };

  return { documents, isLoading, refresh, upload, remove, getSignedUrl };
}
