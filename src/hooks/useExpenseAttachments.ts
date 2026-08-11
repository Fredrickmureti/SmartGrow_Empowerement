/**
 * useExpenseAttachments — canonical receipt trail for an expense.
 *
 * Replaces the single `expenses.receipt_url` string with rows in
 * `public.expense_attachments`. Mutability is enforced by RLS: receipts
 * may only be added or removed while the expense is still open
 * (`draft | pending | submitted | rejected`). Once the expense is
 * approved/posted the trail is immutable — the browser cannot soften
 * that, it only surfaces the resulting error.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeError } from "@/services/resilience";

export interface ExpenseAttachment {
  id: string;
  expense_id: string;
  storage_path: string;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  kind: string;
  uploaded_by: string | null;
  created_at: string;
  /** Derived, not stored. */
  url: string;
}

const BUCKET = "receipts";

export function useExpenseAttachments(expenseId: string | null | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const key = ["expense-attachments", expenseId];

  const query = useQuery({
    queryKey: key,
    enabled: !!expenseId,
    queryFn: async (): Promise<ExpenseAttachment[]> => {
      const { data, error } = await supabase
        .from("expense_attachments")
        .select(
          "id, expense_id, storage_path, file_name, content_type, size_bytes, kind, uploaded_by, created_at",
        )
        .eq("expense_id", expenseId!)
        .order("created_at", { ascending: true });

      if (error) throw error;

      return (data ?? []).map((row) => ({
        ...row,
        url: supabase.storage.from(BUCKET).getPublicUrl(row.storage_path).data
          .publicUrl,
      }));
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!expenseId) throw new Error("Save the expense before attaching receipts");
      if (!currentOrg) throw new Error("No organization selected");

      const ext = file.name.split(".").pop();
      const path = `receipts/${expenseId}/${crypto.randomUUID()}${ext ? `.${ext}` : ""}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { cacheControl: "3600", upsert: false });
      if (uploadError) throw uploadError;

      const { error } = await supabase.from("expense_attachments").insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? null,
        expense_id: expenseId,
        storage_path: path,
        file_name: file.name,
        content_type: file.type || null,
        size_bytes: file.size,
        uploaded_by: user?.id ?? null,
      });

      if (error) {
        // Do not orphan the object when the row is refused (locked expense).
        await supabase.storage.from(BUCKET).remove([path]);
        throw error;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const remove = useMutation({
    mutationFn: async (attachment: ExpenseAttachment) => {
      const { error } = await supabase
        .from("expense_attachments")
        .delete()
        .eq("id", attachment.id);
      if (error) throw error;
      await supabase.storage.from(BUCKET).remove([attachment.storage_path]);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return {
    attachments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error ? normalizeError(query.error).message : null,
    uploadReceipt: upload.mutateAsync,
    isUploading: upload.isPending,
    removeReceipt: remove.mutateAsync,
    isRemoving: remove.isPending,
  };
}
