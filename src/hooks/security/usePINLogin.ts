import { normalizeError } from "@/services/resilience";
/**
 * PIN Login Hook
 * Manages PIN setup, verification, and user-level PIN operations.
 * PIN is per-user (not per-device). Device fingerprint is no longer used for PIN.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

export interface UserPIN {
  id: string;
  user_id: string;
  pin_length: number;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface PINVerificationResult {
  success: boolean;
  error?: string;
  locked?: boolean;
  locked_until?: string;
  attempts_remaining?: number;
}

export function usePINLogin() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Check if current user has PIN set
  const {
    data: hasPin,
    isLoading: isCheckingPin,
    refetch: recheckPin,
  } = useQuery({
    queryKey: ['has-user-pin', user?.id],
    queryFn: async () => {
      if (!user) return false;
      const { data, error } = await supabase.rpc('has_user_pin');
      if (error) {
        console.error('Error checking PIN:', error);
        return false;
      }
      return data as boolean;
    },
    enabled: !!user,
  });

  // Check if PIN is enabled in preferences
  const {
    data: pinEnabled,
    isLoading: isLoadingPinEnabled,
  } = useQuery({
    queryKey: ['pin-enabled', user?.id],
    queryFn: async () => {
      if (!user) return false;
      const { data, error } = await (supabase as any)
        .from('user_security_preferences')
        .select('pin_enabled')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) return false;
      return data?.pin_enabled ?? false;
    },
    enabled: !!user,
  });

  // Get user's PIN info
  const {
    data: userPin,
    isLoading: isLoadingPin,
  } = useQuery({
    queryKey: ['user-pin-info', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data, error } = await supabase
        .from('user_pins')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return data as UserPIN | null;
    },
    enabled: !!user,
  });

  // Set PIN mutation
  const setPinMutation = useMutation({
    mutationFn: async (pin: string) => {
      const { data, error } = await supabase.rpc('set_user_pin', {
        p_pin: pin,
      });
      if (error) throw error;
      const result = data as { success: boolean; error?: string; message?: string };
      if (!result.success) {
        throw new Error(result.error || 'Failed to set PIN');
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['has-user-pin'] });
      queryClient.invalidateQueries({ queryKey: ['user-pin-info'] });
      queryClient.invalidateQueries({ queryKey: ['pin-enabled'] });
      toast({
        title: 'PIN Set Successfully',
        description: 'You can now use your PIN for quick login.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to Set PIN',
        description: normalizeError(error).message,
        variant: 'destructive',
      });
    },
  });

  // Disable PIN mutation
  const disablePinMutation = useMutation({
    mutationFn: async () => {
      // Deactivate the PIN
      const { error: pinError } = await supabase
        .from('user_pins')
        .update({ is_active: false })
        .eq('user_id', user!.id);
      if (pinError) throw pinError;

      // Set pin_enabled = false in preferences
      const { error: prefError } = await (supabase as any)
        .from('user_security_preferences')
        .update({ pin_enabled: false })
        .eq('user_id', user!.id);
      if (prefError) throw prefError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['has-user-pin'] });
      queryClient.invalidateQueries({ queryKey: ['user-pin-info'] });
      queryClient.invalidateQueries({ queryKey: ['pin-enabled'] });
      toast({
        title: 'PIN Disabled',
        description: 'PIN login has been turned off.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to Disable PIN',
        description: normalizeError(error).message,
        variant: 'destructive',
      });
    },
  });

  const isPinLocked = userPin?.locked_until
    ? new Date(userPin.locked_until) > new Date()
    : false;

  return {
    hasPin: hasPin ?? false,
    pinEnabled: pinEnabled ?? false,
    userPin,
    isPinLocked,
    failedAttempts: userPin?.failed_attempts ?? 0,

    isCheckingPin,
    isLoadingPin,
    isLoadingPinEnabled,

    recheckPin,

    setPin: setPinMutation.mutateAsync,
    isSettingPin: setPinMutation.isPending,

    disablePin: disablePinMutation.mutate,
    isDisablingPin: disablePinMutation.isPending,
  };
}
