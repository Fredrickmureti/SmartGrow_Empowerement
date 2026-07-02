/**
 * useRecordFormSubmit — the ONLY approved submit lifecycle for a
 * `/new` or `/:id/edit` route hosted by `RecordFormShell`.
 *
 * It packages the three things every record form needs:
 *   1. an `isSubmitting` flag (drives `RecordFormShell`'s footer spinner)
 *   2. a toast on success + on error (uniform ERP-wide copy)
 *   3. a post-success redirect (usually to the object page or the list)
 *
 * Callers pass in the async work (an already-parameterised mutation).
 * The hook takes care of the try/catch/finally, the toast strings, and
 * the navigate call. Pages MUST NOT hand-roll their own `isSubmitting`
 * useState + try/catch + toast triad — that pattern is the exact drift
 * this hook prevents.
 *
 * Usage:
 *   const submit = useRecordFormSubmit({
 *     entityLabel: "Invoice",
 *     mode: "create",
 *     redirectTo: (result) => `/sales/invoices/${result.id}`,
 *   });
 *
 *   const onSubmit = (e: FormEvent<HTMLFormElement>) => {
 *     e.preventDefault();
 *     submit.run(() => createInvoice({ ... }));
 *   };
 *
 *   <RecordFormShell isSubmitting={submit.isSubmitting} ... />
 */
import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import type { RecordFormMode } from "@/design-system/primitives/RecordFormShell";

interface UseRecordFormSubmitOptions<TResult> {
  /** Entity label used in toast copy (e.g. "Invoice", "Sales Order"). */
  entityLabel: string;
  /** Drives success-toast copy ("created" vs "saved"). */
  mode: RecordFormMode;
  /**
   * Where to redirect after a successful submit. Can be a static path
   * or a function of the mutation's return value. Return null/undefined
   * to stay on the current route (rare — usually only for "Save & new"
   * which the caller handles by resetting form state).
   */
  redirectTo?: string | ((result: TResult) => string | null | undefined);
  /** Optional post-success side effect (invalidations, analytics, etc.). */
  onSuccess?: (result: TResult) => void | Promise<void>;
  /** Override the success toast title. */
  successTitle?: string;
  /** Override the success toast description. */
  successDescription?: string;
}

interface UseRecordFormSubmitReturn<TResult> {
  isSubmitting: boolean;
  /**
   * Execute the mutation. Returns the mutation's result (or `null` on
   * error, so callers can branch — most just ignore the return value).
   */
  run: (mutation: () => Promise<TResult>) => Promise<TResult | null>;
}

export function useRecordFormSubmit<TResult>({
  entityLabel,
  mode,
  redirectTo,
  onSuccess,
  successTitle,
  successDescription,
}: UseRecordFormSubmitOptions<TResult>): UseRecordFormSubmitReturn<TResult> {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const run = useCallback(
    async (mutation: () => Promise<TResult>): Promise<TResult | null> => {
      if (isSubmitting) return null;
      setIsSubmitting(true);
      try {
        const result = await mutation();
        toast({
          title:
            successTitle ??
            (mode === "create"
              ? `${entityLabel} created`
              : `${entityLabel} updated`),
          description: successDescription,
        });
        if (onSuccess) await onSuccess(result);
        if (redirectTo) {
          const target =
            typeof redirectTo === "function" ? redirectTo(result) : redirectTo;
          if (target) navigate(target);
        }
        return result;
      } catch (err) {
        const normalized = normalizeError(err);
        toast({
          title:
            mode === "create"
              ? `Could not create ${entityLabel.toLowerCase()}`
              : `Could not save ${entityLabel.toLowerCase()}`,
          description: normalized.message,
          variant: "destructive",
        });
        return null;
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      isSubmitting,
      toast,
      mode,
      entityLabel,
      successTitle,
      successDescription,
      onSuccess,
      redirectTo,
      navigate,
    ],
  );

  return { isSubmitting, run };
}
