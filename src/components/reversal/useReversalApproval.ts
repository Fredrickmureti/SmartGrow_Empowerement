/**
 * useReversalApproval — client view of the reversal approval policy
 * (ADR 0129, Phase 5.3).
 *
 * The decision is the server's: `reversal_approval_requirement` reads the
 * organization's `reversal_approval_policies` row and the live approval
 * request, and `assert_can_reverse` refuses the writer until the request is
 * approved. This hook exists so the dialog can say so BEFORE the operator
 * commits, and so "Request approval" routes through the one approval engine
 * (`request_reversal_approval` → `approval_route`) rather than a screen-local
 * shortcut.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import type { ReversalDocumentType } from "./useReversalReasonCodes";

export interface ReversalApprovalRequirement {
  required: boolean;
  satisfied: boolean;
  reasons: string[];
  amount: number | null;
  amount_threshold: number | null;
  action_key: string;
  request_id: string | null;
  request_status: string | null;
}

const EMPTY: ReversalApprovalRequirement = {
  required: false,
  satisfied: true,
  reasons: [],
  amount: null,
  amount_threshold: null,
  action_key: "",
  request_id: null,
  request_status: null,
};

export function useReversalApproval(
  documentType: ReversalDocumentType,
  documentId: string | null | undefined,
  operation: string,
  enabled = true,
) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["reversal-approval", documentType, documentId, operation];

  const query = useQuery({
    queryKey,
    enabled: Boolean(enabled && documentId),
    // Policy state moves under a long-lived dialog (an approver may decide
    // while it is open), so this is never cached across opens.
    staleTime: 0,
    queryFn: async (): Promise<ReversalApprovalRequirement> => {
      const { data, error } = await supabase.rpc(
        "reversal_approval_requirement" as any,
        {
          _document_type: documentType,
          _document_id: documentId,
          _operation: operation,
        } as any,
      );
      if (error) throw error;
      const row = (data ?? {}) as Record<string, unknown>;
      return {
        required: Boolean(row.required),
        satisfied: row.satisfied !== false,
        reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
        amount: row.amount == null ? null : Number(row.amount),
        amount_threshold:
          row.amount_threshold == null ? null : Number(row.amount_threshold),
        action_key: String(row.action_key ?? ""),
        request_id: (row.request_id as string | null) ?? null,
        request_status: (row.request_status as string | null) ?? null,
      };
    },
  });

  const mutation = useMutation({
    mutationFn: async (input: { reasonCode: string; comment: string }) => {
      const { data, error } = await supabase.rpc(
        "request_reversal_approval" as any,
        {
          _document_type: documentType,
          _document_id: documentId,
          _operation: operation,
          _reason_code: input.reasonCode,
          _comment: input.comment,
        } as any,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["approval-requests"] });
      toast({
        title: "Approval requested",
        description:
          "The reversal is waiting for an approver. It can be completed once approved.",
      });
    },
    onError: (error: unknown) => {
      toast({
        title: "Could not request approval",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  const requestApproval = useCallback(
    (reasonCode: string, comment: string) =>
      mutation.mutateAsync({ reasonCode, comment }),
    [mutation],
  );

  const approval = query.data ?? EMPTY;

  return {
    approval,
    /** True when the writer would refuse: approval is required and not granted. */
    isBlockedPendingApproval: approval.required && !approval.satisfied,
    isLoading: query.isLoading,
    isError: query.isError,
    requestApproval,
    isRequesting: mutation.isPending,
  };
}
