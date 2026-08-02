/**
 * Return line photos — evidence for condition and damage claims.
 *
 * Photos live in storage; `wms_return_photos` holds the pointer plus the
 * capture audit. Camera access itself belongs to the capture component, not
 * to this hook.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ReturnPhoto } from "./returnsModel";
import { RETURN_LINES_KEY } from "./useReturnLines";

export const RETURN_PHOTOS_KEY = "wms-return-photos";
const BUCKET = "documents";

export function useReturnPhotos(returnId: string | null | undefined) {
  return useQuery({
    queryKey: [RETURN_PHOTOS_KEY, returnId],
    enabled: !!returnId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_return_photos" as any)
        .select(
          "id, return_line_id, return_order_id, storage_bucket, storage_path, kind, caption, captured_at",
        )
        .eq("return_order_id", returnId!)
        .order("captured_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ReturnPhoto[];
    },
  });
}

export function useUploadReturnPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      organizationId: string;
      businessId: string;
      returnId: string;
      lineId: string;
      file: File | Blob;
      kind?: string;
      caption?: string | null;
    }) => {
      const ext = input.file instanceof File ? input.file.name.split(".").pop() : "jpg";
      const path = `returns/${input.returnId}/${input.lineId}/${Date.now()}.${ext || "jpg"}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, input.file, {
        cacheControl: "3600",
        upsert: false,
      });
      if (upErr) throw upErr;

      const { data, error } = await supabase
        .from("wms_return_photos" as any)
        .insert({
          organization_id: input.organizationId,
          business_id: input.businessId,
          return_order_id: input.returnId,
          return_line_id: input.lineId,
          storage_bucket: BUCKET,
          storage_path: path,
          kind: input.kind ?? "condition",
          caption: input.caption ?? null,
        })
        .select("id")
        .single();
      if (error) throw error;

      const { count } = await supabase
        .from("wms_return_photos" as any)
        .select("id", { count: "exact", head: true })
        .eq("return_line_id", input.lineId);
      await supabase
        .from("wms_return_lines" as any)
        .update({ photo_count: count ?? 0 })
        .eq("id", input.lineId);

      return data as unknown as { id: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [RETURN_PHOTOS_KEY] });
      qc.invalidateQueries({ queryKey: [RETURN_LINES_KEY] });
    },
  });
}

/** Signed URL for viewing a stored photo. */
export async function returnPhotoUrl(photo: ReturnPhoto): Promise<string | null> {
  const { data } = await supabase.storage
    .from(photo.storage_bucket || BUCKET)
    .createSignedUrl(photo.storage_path, 3600);
  return data?.signedUrl ?? null;
}
