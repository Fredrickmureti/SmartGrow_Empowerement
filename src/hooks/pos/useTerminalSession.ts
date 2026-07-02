import { useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useBusinesses } from '@/contexts/BusinessContext';

interface POSSession {
  id: string;
  cashier_id: string;
  register_id: string;
  organization_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  locked_at: string | null;
  lock_reason: string | null;
  cashier?: {
    id: string;
    display_name: string;
    employee_number: string | null;
    user_id: string;
  };
}

interface Cashier {
  id: string;
  display_name: string;
  employee_number: string | null;
  is_active: boolean;
}

export function useTerminalSession(organizationId: string | undefined, registerId: string | undefined) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { currentBusiness } = useBusinesses();

  // Check if register requires cashier login
  const { data: registerSettings } = useQuery({
    queryKey: ['register-security-settings', registerId],
    queryFn: async () => {
      if (!registerId) return null;
      
      // SCOPE-EXEMPT: PK lookup by register.id; RLS already restricts to org.
      const { data, error } = await supabase
        .from('pos_registers')
        .select('require_cashier_login, auto_lock_minutes')
        .eq('id', registerId)
        .single();

      if (error) throw error;
      return data;
    },
    enabled: !!registerId,
  });

  // Fetch active session for this register.
  // AI-2: Resolve the register's business_id from the register itself (single source
  // of truth) and add it as a defensive scope filter. We never trust the active UI
  // company because tab-switches can desync it from the register's actual owner.
  const { data: activeSession, isLoading: isLoadingSession, refetch: refetchSession } = useQuery({
    queryKey: ['terminal-session', organizationId, registerId],
    queryFn: async (): Promise<POSSession | null> => {
      if (!organizationId || !registerId) return null;

      // SCOPE-EXEMPT: resolving register's business_id + branch_id from PK; verified vs org below.
      const { data: register, error: regErr } = await supabase
        .from('pos_registers')
        .select('business_id, branch_id')
        .eq('id', registerId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (regErr) throw regErr;
      if (!register?.business_id) return null;

      const { data, error } = await supabase
        .from('pos_sessions')
        .select(`
          *,
          cashier:pos_cashiers(
            id,
            display_name,
            employee_number,
            user_id
          )
        `)
        .eq('organization_id', organizationId)
        .eq('business_id', register.business_id)
        .eq('register_id', registerId)
        .eq('status', 'active')
        .is('ended_at', null)
        .maybeSingle();

      if (error) throw error;
      // Attach the resolved branch_id so the realtime effect can scope by it.
      const session = data as (POSSession & { branch_id?: string | null }) | null;
      if (session) (session as unknown as Record<string, unknown>).register_branch_id = register.branch_id;
      return session;
    },
    enabled: !!organizationId && !!registerId,
    refetchInterval: 30000, // Refetch every 30 seconds as backup
  });

  // Fetch cashiers assigned to this register
  const { data: assignedCashiers = [] } = useQuery({
    queryKey: ['register-cashiers', organizationId, registerId],
    queryFn: async (): Promise<Cashier[]> => {
      if (!organizationId || !registerId) return [];
      
      const { data, error } = await supabase
        .from('pos_cashier_registers')
        .select(`
          cashier:pos_cashiers(
            id,
            display_name,
            employee_number,
            is_active
          )
        `)
        .eq('register_id', registerId);

      if (error) throw error;
      
      return (data || [])
        .map((d: { cashier: Cashier | null }) => d.cashier)
        .filter((c): c is Cashier => c !== null && c.is_active);
    },
    enabled: !!organizationId && !!registerId,
  });

  // Subscribe to real-time session changes
  useEffect(() => {
    if (!organizationId || !registerId) return;
    // Defensive: do not subscribe to a register whose business does not match
    // the user's active company. Postgres realtime filters do not enforce RLS
    // identically to row reads, so a register that was moved between
    // companies could otherwise fan out cross-company payloads.
    const expectedBusinessId = currentBusiness?.id ?? null;
    // Stage B (branch isolation): also drop payloads whose branch_id does
    // not match the register's owning branch. This prevents cross-branch
    // session events from leaking when a register is reassigned or when
    // realtime filters race the application-layer context.
    const expectedBranchId =
      (activeSession as unknown as { register_branch_id?: string | null } | null)
        ?.register_branch_id ?? null;

    const channel = supabase
      .channel(
        `terminal-session-${registerId}-${expectedBusinessId ?? 'no-business'}-${expectedBranchId ?? 'no-branch'}`,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pos_sessions',
          filter: `register_id=eq.${registerId}`,
        },
        (payload) => {
          // Drop payloads that don't belong to the active company or branch.
          const newRow = payload.new as { business_id?: string | null; branch_id?: string | null } | null;
          const oldRow = payload.old as { business_id?: string | null; branch_id?: string | null } | null;
          const payloadBusinessId =
            newRow?.business_id ?? oldRow?.business_id ?? null;
          if (
            expectedBusinessId &&
            payloadBusinessId &&
            payloadBusinessId !== expectedBusinessId
          ) {
            return;
          }
          const payloadBranchId =
            newRow?.branch_id ?? oldRow?.branch_id ?? null;
          if (
            expectedBranchId &&
            payloadBranchId &&
            payloadBranchId !== expectedBranchId
          ) {
            return;
          }
          console.log('Session change:', payload);
          
          // Handle session termination by manager
          if (payload.eventType === 'UPDATE') {
            const newData = payload.new as POSSession;
            
            if (newData.status === 'ended' || newData.status === 'terminated') {
              toast({
                title: 'Session Ended',
                description: 'Your session has been terminated by a manager.',
                variant: 'destructive',
              });
            } else if (newData.locked_at && !activeSession?.locked_at) {
              toast({
                title: 'Terminal Locked',
                description: newData.lock_reason || 'Terminal has been locked.',
              });
            }
          }
          
          // Invalidate queries to refresh session state
          queryClient.invalidateQueries({ queryKey: ['terminal-session'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [
    organizationId,
    registerId,
    currentBusiness?.id,
    queryClient,
    toast,
    activeSession?.locked_at,
    (activeSession as unknown as { register_branch_id?: string | null } | null)?.register_branch_id,
  ]);

  // Subscribe to cashier status changes (for immediate lockout when cashier is deactivated)
  useEffect(() => {
    if (!organizationId || !activeSession?.cashier_id) return;

    const channel = supabase
      .channel(`cashier-status-${activeSession.cashier_id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'pos_cashiers',
          filter: `id=eq.${activeSession.cashier_id}`,
        },
        (payload) => {
          const newData = payload.new as { is_active: boolean };
          
          if (!newData.is_active) {
            toast({
              title: 'Account Deactivated',
              description: 'Your cashier account has been deactivated.',
              variant: 'destructive',
            });
            queryClient.invalidateQueries({ queryKey: ['terminal-session'] });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [organizationId, activeSession?.cashier_id, queryClient, toast]);

  // Check if login is required
  const requiresLogin = registerSettings?.require_cashier_login ?? false;
  const isLocked = !!activeSession?.locked_at;
  const hasActiveSession = !!activeSession && activeSession.status === 'active';

  // Should show lock screen?
  const shouldShowLockScreen = requiresLogin && (!hasActiveSession || isLocked);

  return {
    activeSession,
    isLoadingSession,
    assignedCashiers,
    requiresLogin,
    isLocked,
    hasActiveSession,
    shouldShowLockScreen,
    autoLockMinutes: registerSettings?.auto_lock_minutes,
    refetchSession,
  };
}
