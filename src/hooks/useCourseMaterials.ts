/**
 * useCourseMaterials — list/create/delete training course materials and upload
 * files to the existing private `documents` storage bucket under
 * `{org_id}/training-courses/{course_id}/{uuid}-{filename}`.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type MaterialKind = "file" | "link" | "text";

export interface CourseMaterial {
  id: string;
  organization_id: string;
  course_id: string;
  kind: MaterialKind;
  title: string;
  description: string | null;
  file_path: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  external_url: string | null;
  content_text: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

const BUCKET = "documents";
const MAX_BYTES = 50 * 1024 * 1024; // 50MB

export function useCourseMaterials(courseId: string | undefined) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: materials = [], isLoading } = useQuery({
    queryKey: ["course-materials", courseId],
    enabled: !!courseId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("training_course_materials")
        .select("*")
        .eq("course_id", courseId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CourseMaterial[];
    },
  });

  const signedUrl = async (path: string): Promise<string | null> => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
    if (error) return null;
    return data?.signedUrl ?? null;
  };

  const addLink = useMutation({
    mutationFn: async (input: { title: string; external_url: string; description?: string }) => {
      if (!currentOrg?.id || !courseId) throw new Error("Missing context");
      const { error } = await (supabase as any).from("training_course_materials").insert({
        organization_id: currentOrg.id,
        course_id: courseId,
        kind: "link",
        title: input.title,
        external_url: input.external_url,
        description: input.description ?? null,
        position: materials.length,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["course-materials", courseId] }); toast.success("Link added"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const addText = useMutation({
    mutationFn: async (input: { title: string; content_text: string }) => {
      if (!currentOrg?.id || !courseId) throw new Error("Missing context");
      const { error } = await (supabase as any).from("training_course_materials").insert({
        organization_id: currentOrg.id,
        course_id: courseId,
        kind: "text",
        title: input.title,
        content_text: input.content_text,
        position: materials.length,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["course-materials", courseId] }); toast.success("Lesson added"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const addFile = useMutation({
    mutationFn: async (input: { title: string; file: File }) => {
      if (!currentOrg?.id || !courseId) throw new Error("Missing context");
      if (input.file.size > MAX_BYTES) throw new Error("File exceeds 50 MB limit");
      const cleanName = input.file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${currentOrg.id}/training-courses/${courseId}/${crypto.randomUUID()}-${cleanName}`;
      const up = await supabase.storage.from(BUCKET).upload(path, input.file, {
        contentType: input.file.type || undefined,
        upsert: false,
      });
      if (up.error) throw up.error;
      const { error } = await (supabase as any).from("training_course_materials").insert({
        organization_id: currentOrg.id,
        course_id: courseId,
        kind: "file",
        title: input.title || input.file.name,
        file_path: path,
        file_name: input.file.name,
        file_size: input.file.size,
        mime_type: input.file.type || null,
        position: materials.length,
      });
      if (error) {
        // best-effort cleanup
        await supabase.storage.from(BUCKET).remove([path]);
        throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["course-materials", courseId] }); toast.success("File uploaded"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const remove = useMutation({
    mutationFn: async (material: CourseMaterial) => {
      if (material.kind === "file" && material.file_path) {
        await supabase.storage.from(BUCKET).remove([material.file_path]);
      }
      const { error } = await (supabase as any).from("training_course_materials").delete().eq("id", material.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["course-materials", courseId] }); toast.success("Removed"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const reorder = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      // Persist new positions sequentially (small N — fine without batching)
      for (let i = 0; i < orderedIds.length; i++) {
        const { error } = await (supabase as any)
          .from("training_course_materials")
          .update({ position: i })
          .eq("id", orderedIds[i]);
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["course-materials", courseId] }); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { materials, isLoading, addLink, addText, addFile, remove, reorder, signedUrl };
}
