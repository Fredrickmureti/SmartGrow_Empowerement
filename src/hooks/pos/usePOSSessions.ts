import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useBusinesses } from '@/hooks/useBusinesses';
import { normalizeError } from "@/services/resilience";

interface CreateSessionParams {
  cashierId: string;
  registerId: string;
  pin: string;
  terminalId?: string;
}

interface ManagerLoginParams {
  registerId: string;
  pin: string;
  organizationId: string;
}

export function usePOSSessions(organizationId: string | undefined, registerId?: string) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { currentBusiness } = useBusinesses();

  // Fetch active session for a register
  const { data: activeSession, isLoading: isLoadingSession, refetch: refetchSession } = useQuery({
    queryKey: ['pos-active-session', organizationId, currentBusiness?.id, registerId],
    queryFn: async () => {
      if (!organizationId || !registerId || !currentBusiness?.id) return null;

      const { data, error } = await supabase
        .from('pos_sessions')
        .select(`
          *,
          cashier:pos_cashiers(
            id,
            display_name,
            employee_number,
            user_id,
            max_discount_percent,
            max_void_amount,
            can_apply_discounts,
            can_void_transactions,
            can_process_returns,
            can_open_cash_drawer
          )
        `)
        .eq('organization_id', organizationId)
        .eq("business_id", currentBusiness.id)
        .eq('register_id', registerId)
        .eq('status', 'active')
        .is('ended_at', null)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
    enabled: !!organizationId && !!registerId && !!currentBusiness?.id,
  });

  // Verify PIN and create session
  const loginMutation = useMutation({
    mutationFn: async ({ cashierId, registerId, pin, terminalId }: CreateSessionParams) => {
      // First verify the PIN
      const { data: pinValid, error: pinError } = await supabase
        .rpc('verify_cashier_pin', { 
          p_cashier_id: cashierId, 
          p_pin: pin 
        });

      if (pinError) throw pinError;
      if (!pinValid) throw new Error('Invalid PIN');

      // Check if cashier is active and assigned to this register
      const { data: cashier, error: cashierError } = await supabase
        .from('pos_cashiers')
        .select(`
          *,
          registers:pos_cashier_registers(register_id)
        `)
        .eq('id', cashierId)
        .eq('is_active', true)
        .single();

      if (cashierError) throw cashierError;
      if (!cashier) throw new Error('Cashier not found or inactive');

      const isAssigned = cashier.registers?.some((r: { register_id: string }) => r.register_id === registerId);
      if (!isAssigned) throw new Error('Cashier not assigned to this register');

      if (!currentBusiness?.id) throw new Error('Select a Company before signing in to POS');

      // Resolve register's authoritative scope (single source of truth — never trust UI context)
      const { data: register, error: registerError } = await supabase
        .from('pos_registers')
        .select('id, organization_id, business_id, branch_id')
        .eq('id', registerId)
        .single();
      if (registerError) throw registerError;
      if (!register?.branch_id) throw new Error('Register has no branch context');
      if (register.business_id !== currentBusiness.id) {
        throw new Error('Active company does not match this register');
      }

      // AI-3: scope stale-session cleanup to this cashier *within this company* only.
      await supabase
        .from('pos_sessions')
        .update({ 
          status: 'ended', 
          ended_at: new Date().toISOString(),
          lock_reason: 'New session started'
        })
        .eq('cashier_id', cashierId)
        .eq('business_id', register.business_id)
        .eq('status', 'active');

      // Create new session — branch_id is now NOT NULL on pos_sessions; resolve from register.
      const { data: session, error: sessionError } = await supabase
        .from('pos_sessions')
        .insert({
          cashier_id: cashierId,
          register_id: registerId,
          organization_id: register.organization_id,
          business_id: register.business_id,
          branch_id: register.branch_id,
          status: 'active',
        })
        .select()
        .single();

      if (sessionError) throw sessionError;

      return { session, cashier };
    },
    onSuccess: (data) => {
      // Immediately update the cache for instant UI response
      const sessionData = {
        ...data.session,
        cashier: {
          id: data.cashier.id,
          display_name: data.cashier.display_name,
          employee_number: data.cashier.employee_number,
          user_id: data.cashier.user_id,
          max_discount_percent: data.cashier.max_discount_percent,
          max_void_amount: data.cashier.max_void_amount,
          can_apply_discounts: data.cashier.can_apply_discounts,
          can_void_transactions: data.cashier.can_void_transactions,
          can_process_returns: data.cashier.can_process_returns,
          can_open_cash_drawer: data.cashier.can_open_cash_drawer,
        },
      };
      queryClient.setQueryData(['pos-active-session', organizationId, registerId], sessionData);
      queryClient.setQueryData(['terminal-session', organizationId, registerId], sessionData);
      
      toast({
        title: 'Logged In',
        description: `Welcome, ${data.cashier.display_name}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Login Failed',
        description: normalizeError(error).message,
        variant: 'destructive',
      });
    },
  });

  // Manager login - bypasses cashier requirement
  const managerLoginMutation = useMutation({
    mutationFn: async ({ registerId, pin, organizationId }: ManagerLoginParams) => {
      if (!currentBusiness?.id) throw new Error('Select a Company before manager sign-in');
      // First, get all active manager pins for this org and try each one
      const { data: managerPins, error: pinsError } = await supabase
        .from('pos_manager_pins')
        .select('user_id')
        .eq('organization_id', organizationId)
        .eq("business_id", currentBusiness.id)
        .eq('is_active', true);

      if (pinsError) throw pinsError;
      if (!managerPins || managerPins.length === 0) {
        throw new Error('No manager PINs configured for this organization');
      }

      // Try to verify PIN against each manager
      let validManagerId: string | null = null;
      for (const manager of managerPins) {
        const { data: isValid } = await supabase
          .rpc('verify_manager_pin' as any, { 
            p_organization_id: organizationId,
            p_business_id: currentBusiness.id,
            p_manager_id: manager.user_id,
            p_pin: pin 
          } as any);

        if (isValid) {
          validManagerId = manager.user_id;
          break;
        }
      }

      if (!validManagerId) {
        throw new Error('Invalid manager PIN');
      }

      // Get the manager's profile for display
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('user_id', validManagerId)
        .single();

      // Resolve register's authoritative scope (branch_id is required on pos_sessions).
      const { data: register, error: registerError } = await supabase
        .from('pos_registers')
        .select('id, organization_id, business_id, branch_id')
        .eq('id', registerId)
        .single();
      if (registerError) throw registerError;
      if (!register?.branch_id) throw new Error('Register has no branch context');
      if (register.business_id !== currentBusiness.id || register.organization_id !== organizationId) {
        throw new Error('Active company does not match this register');
      }

      // Create a manager session (without cashier_id)
      const { data: session, error: sessionError } = await supabase
        .from('pos_sessions')
        .insert({
          register_id: registerId,
          organization_id: register.organization_id,
          business_id: register.business_id,
          branch_id: register.branch_id,
          status: 'active',
          session_type: 'manager',
        } as any)
        .select()
        .single();

      if (sessionError) throw sessionError;

      return { session, isManager: true, managerName: profile?.full_name || profile?.email || 'Manager' };
    },
    onSuccess: (data) => {
      // Immediately update the cache for instant UI response
      const sessionData = {
        ...data.session,
        cashier: {
          id: 'manager',
          display_name: data.managerName,
          employee_number: null,
          user_id: null,
        },
      };
      queryClient.setQueryData(['pos-active-session', organizationId, registerId], sessionData);
      queryClient.setQueryData(['terminal-session', organizationId, registerId], sessionData);
      
      toast({
        title: 'Manager Access Granted',
        description: `Welcome, ${data.managerName}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Manager Login Failed',
        description: normalizeError(error).message,
        variant: 'destructive',
      });
    },
  });

  // Lock session (temporary lock) - works for both cashier and manager sessions
  const lockSessionMutation = useMutation({
    mutationFn: async (reason?: string) => {
      if (!activeSession?.id) throw new Error('No active session');

      // For manager sessions or if the RPC doesn't work, directly update the session
      const { error } = await supabase
        .from('pos_sessions')
        .update({ 
          locked_at: new Date().toISOString(), 
          lock_reason: reason || 'Manual lock' 
        })
        .eq('id', activeSession.id);

      if (error) throw error;
    },
    onSuccess: () => {
      // Immediately update the cache for instant UI response
      const currentSession = queryClient.getQueryData(['terminal-session', organizationId, registerId]) as Record<string, unknown> | undefined;
      if (currentSession) {
        const lockedSession = {
          ...currentSession,
          locked_at: new Date().toISOString(),
          lock_reason: 'Manual lock',
        };
        queryClient.setQueryData(['pos-active-session', organizationId, registerId], lockedSession);
        queryClient.setQueryData(['terminal-session', organizationId, registerId], lockedSession);
      }
      
      toast({
        title: 'Terminal Locked',
        description: 'Enter PIN to unlock',
      });
    },
  });

  // Unlock session with PIN - supports both cashier and manager sessions
  const unlockSessionMutation = useMutation({
    mutationFn: async (pin: string) => {
      if (!activeSession?.id) throw new Error('No active session');

      // Check if this is a manager session (no cashier_id or session_type = 'manager')
      const isManagerSession = !activeSession.cashier_id || activeSession.session_type === 'manager';

      if (isManagerSession) {
        if (!currentBusiness?.id) throw new Error('No active company');
        // For manager sessions, verify against manager PINs
        const { data: managerPins } = await supabase
          .from('pos_manager_pins')
          .select('user_id')
          .eq('organization_id', organizationId!)
          .eq("business_id", currentBusiness.id)
          .eq('is_active', true);

        let pinValid = false;
        if (managerPins) {
          for (const manager of managerPins) {
            const { data: isValid } = await supabase
              .rpc('verify_manager_pin' as any, { 
                p_organization_id: organizationId!,
                p_business_id: currentBusiness.id,
                p_manager_id: manager.user_id,
                p_pin: pin 
              } as any);
            if (isValid) {
              pinValid = true;
              break;
            }
          }
        }
        if (!pinValid) throw new Error('Invalid manager PIN');
      } else {
        // For cashier sessions, verify cashier PIN
        const { data: pinValid, error: pinError } = await supabase
          .rpc('verify_cashier_pin', { 
            p_cashier_id: activeSession.cashier_id, 
            p_pin: pin 
          });

        if (pinError) throw pinError;
        if (!pinValid) throw new Error('Invalid PIN');
      }

      const { error } = await supabase
        .from('pos_sessions')
        .update({ 
          locked_at: null, 
          lock_reason: null 
        })
        .eq('id', activeSession.id);

      if (error) throw error;
    },
    onSuccess: () => {
      // Immediately update the cache for instant UI response
      const currentSession = queryClient.getQueryData(['terminal-session', organizationId, registerId]) as Record<string, unknown> | undefined;
      if (currentSession) {
        const unlockedSession = {
          ...currentSession,
          locked_at: null,
          lock_reason: null,
        };
        queryClient.setQueryData(['pos-active-session', organizationId, registerId], unlockedSession);
        queryClient.setQueryData(['terminal-session', organizationId, registerId], unlockedSession);
      }
      
      toast({
        title: 'Terminal Unlocked',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Unlock Failed',
        description: normalizeError(error).message,
        variant: 'destructive',
      });
    },
  });

  // End session (logout)
  const logoutMutation = useMutation({
    mutationFn: async () => {
      if (!activeSession?.id) throw new Error('No active session');

      const { error } = await supabase
        .from('pos_sessions')
        .update({ 
          status: 'ended', 
          ended_at: new Date().toISOString() 
        })
        .eq('id', activeSession.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pos-active-session'] });
      toast({
        title: 'Logged Out',
        description: 'Session ended successfully',
      });
    },
  });

  return {
    activeSession,
    isLoadingSession,
    isLocked: !!activeSession?.locked_at,
    refetchSession,
    
    login: loginMutation.mutate,
    isLoggingIn: loginMutation.isPending,
    
    managerLogin: managerLoginMutation.mutate,
    isManagerLoggingIn: managerLoginMutation.isPending,
    
    lockSession: lockSessionMutation.mutate,
    isLocking: lockSessionMutation.isPending,
    
    unlockSession: unlockSessionMutation.mutate,
    isUnlocking: unlockSessionMutation.isPending,
    
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
}
