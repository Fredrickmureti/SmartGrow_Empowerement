import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { humanizePosError } from '@/lib/pos/humanizePosError';
import { normalizeError } from "@/services/resilience";
import {
  type TerminalSessionEnvelope,
  useTerminalSessionEnvelope,
  mergeEnvelope,
  assertActiveTerminalSession,
  TerminalSessionMissingFieldError,
  describeMissingField,
} from "@/services/pos/session/TerminalSessionEnvelope";

// Stage 8: must mirror the action enum in pos_override_matrix.action_chk.
// `assert_manager_override` rejects with `override_action_mismatch` if the
// override row's `override_type` does not equal the matrix action requested
// by the calling RPC, so client-side action strings are load-bearing.
export type OverrideAction =
  | 'void_transaction'
  | 'void_above_threshold'
  | 'refund'
  | 'cross_tender_refund'
  | 'discount_over_limit'
  | 'price_change'
  | 'manual_price'
  | 'delete_item'
  | 'no_sale'
  | 'cash_drop'
  | 'cash_out_above_threshold'
  | 'safe_drop'
  | 'bank_deposit'
  | 'shift_variance'
  | 'reopen_shift'
  | 'force_close_shift'
  | 'override_age_check';

interface OverrideRequest {
  action: OverrideAction;
  pin: string;
  sessionId?: string;
  shiftId?: string;
  registerId: string;
  transactionId?: string;
  itemId?: string;
  originalValue?: number | string;
  newValue?: number | string;
  reason?: string;
}

interface OverrideResult {
  success: boolean;
  overrideId: string;
  managerName: string;
}

/**
 * Manager PIN override capture, consuming the canonical
 * `TerminalSessionEnvelope` (Stage 1 remediation, see
 * `src/services/pos/session/TerminalSessionEnvelope.ts`).
 *
 * Overloads:
 *   - `useManagerOverride()`
 *       reads the ambient terminal envelope from context.
 *   - `useManagerOverride({ businessId })`
 *       merges partial overrides onto the ambient envelope.
 *       Used by rescue / reopen flows that target a different
 *       business than the currently-selected one.
 *
 * The legacy `useManagerOverride(orgId, businessId?)` positional
 * signature is REMOVED. The ESLint rule
 * `local/no-loose-manager-override-args` fails the build on any
 * call site that tries to reintroduce loose scalar arguments.
 * See `.lovable/plan.md` Stage 1 for the rationale.
 */
export function useManagerOverride(
  overrides?: Partial<TerminalSessionEnvelope>,
) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const ambient = useTerminalSessionEnvelope();
  const envelope = mergeEnvelope(ambient, overrides);

  const verifyOverrideMutation = useMutation({
    mutationFn: async (request: OverrideRequest): Promise<OverrideResult> => {
      const active = assertActiveTerminalSession(envelope);
      const { organizationId, businessId } = active;

      // pos_manager_pins IS business-scoped (added in Phase A) — filter by both axes.
      const { data: managerPins, error: pinsError } = await supabase
        .from('pos_manager_pins')
        .select(`
          id,
          user_id,
          is_active
        `)
        .eq('organization_id', organizationId)
        .eq('business_id', businessId)
        .eq('is_active', true);

      if (pinsError) throw pinsError;
      if (!managerPins?.length) throw new Error('No manager PINs configured');

      // Try to verify PIN against each manager
      let validManager: { id: string; user_id: string } | null = null;
      for (const manager of managerPins) {
        const { data: isValid, error: verifyError } = await supabase
          .rpc('verify_manager_pin' as any, {
            p_manager_id: manager.user_id,
            p_organization_id: organizationId,
            p_business_id: businessId,
            p_pin: request.pin
          } as any);

        if (verifyError) continue;
        if (isValid) {
          validManager = manager;
          break;
        }
      }

      if (!validManager) throw new Error('Invalid manager PIN');

      // Get manager name
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', validManager.user_id)
        .maybeSingle();

      // Stage 6.1: pos_manager_overrides now has business_id + shift_id +
      // status + consumed_at columns. Pass them through so the cash-movement
      // RPC can enforce shift scope and single-use consumption.
      const { data: override, error: overrideError } = await supabase
        .from('pos_manager_overrides')
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          manager_id: validManager.user_id,
          session_id: request.sessionId || null,
          shift_id: request.shiftId || active.shiftId || null,
          register_id: request.registerId || active.registerId || null,
          override_type: request.action,
          transaction_id: request.transactionId || null,
          original_value: typeof request.originalValue === 'string' ? parseFloat(request.originalValue) : request.originalValue,
          new_value: typeof request.newValue === 'string' ? parseFloat(request.newValue) : request.newValue,
          override_reason: request.reason,
          status: 'approved',
        } as any)
        .select()
        .single();

      if (overrideError) throw overrideError;

      return {
        success: true,
        overrideId: override.id,
        managerName: profile?.full_name || 'Manager',
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['pos-manager-overrides'] });
      toast({
        title: 'Override Approved',
        description: `Approved by ${data.managerName}`,
      });
    },
    onError: (error: Error) => {
      // Stage 1: distinguish "envelope is missing a required field"
      // (a client-side config / hydration problem) from a real
      // authorization failure. The historical blanket "Override Denied"
      // toast masked the former as the latter, which is what produced
      // the reported "Override denied · An unexpected error occurred ·
      // Company not selected" cascade.
      if (error instanceof TerminalSessionMissingFieldError) {
        toast({
          title: 'Terminal not ready',
          description: describeMissingField(error.field),
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: 'Override Denied',
        description: humanizePosError(normalizeError(error).message),
        variant: 'destructive',
      });
    },
  });

  return {
    requestOverride: verifyOverrideMutation.mutateAsync,
    isVerifying: verifyOverrideMutation.isPending,
    /**
     * Exposed so callers that need to gate UI on envelope readiness
     * (e.g. disable a "Reverse" button until the envelope is ready)
     * can do so without re-reading the ambient contexts themselves.
     */
    envelopeReady: envelope.ready,
  };
}
