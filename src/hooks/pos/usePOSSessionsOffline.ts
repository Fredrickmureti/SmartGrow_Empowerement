/**
 * Offline-capable POS Sessions Hook
 * Handles POS session operations with offline support for Electron
 * Combines useTerminalSession + usePOSSessions into one offline-aware hook
 */

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { syncManager } from '@/services/offline';
import { terminalLockService } from '@/services/offline/TerminalLockService';
import { isElectron } from '@/lib/environment';
import { normalizeError } from '@/services/resilience/ErrorNormalizer';

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

interface OfflineSession {
  id: string;
  cashier_id: string | null;
  register_id: string;
  organization_id: string;
  business_id: string;
  branch_id: string;
  status: 'active' | 'ended';
  locked_at: string | null;
  lock_reason: string | null;
  session_type?: 'cashier' | 'manager';
  cashier?: {
    id: string;
    display_name: string;
    employee_number: string | null;
    user_id: string | null;
    max_discount_percent: number | null;
    max_void_amount: number | null;
    can_apply_discounts: boolean | null;
    can_void_transactions: boolean | null;
    can_process_returns: boolean | null;
    can_open_cash_drawer: boolean | null;
  } | null;
}

interface Cashier {
  id: string;
  display_name: string;
  employee_number: string | null;
  is_active: boolean;
}

interface RegisterSettings {
  require_cashier_login: boolean;
  auto_lock_minutes: number | null;
}

interface RegisterContext extends RegisterSettings {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string;
}

// Local storage keys
const OFFLINE_SESSION_KEY = 'pos_offline_session';
const OFFLINE_REGISTER_SETTINGS_KEY = 'pos_offline_register_settings';
const OFFLINE_CASHIERS_KEY = 'pos_offline_cashiers';

export function usePOSSessionsOffline(organizationId: string | undefined, registerId?: string) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const getOfflineRegisterContext = (): RegisterContext | null => {
    try {
      const stored = localStorage.getItem(`${OFFLINE_REGISTER_SETTINGS_KEY}_${registerId}`);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  };

  const saveOfflineRegisterContext = (context: RegisterContext) => {
    localStorage.setItem(`${OFFLINE_REGISTER_SETTINGS_KEY}_${registerId}`, JSON.stringify(context));
  };

  const { data: registerContext } = useQuery({
    queryKey: ['pos-register-context-offline', organizationId, registerId],
    queryFn: async (): Promise<RegisterContext | null> => {
      if (!organizationId || !registerId) return null;

      if (!syncManager.checkOnline()) return getOfflineRegisterContext();

      try {
        // SCOPE-EXEMPT: PK lookup by register.id; business_id is being READ from this row.
        const { data, error } = await supabase
          .from('pos_registers')
          .select('id, organization_id, business_id, branch_id, require_cashier_login, auto_lock_minutes')
          .eq('id', registerId)
          .eq('organization_id', organizationId)
          .single();

        if (error) throw error;
        if (!data?.business_id || !data?.branch_id) {
          throw new Error('Register is missing required company or branch context');
        }

        const context = data as RegisterContext;
        saveOfflineRegisterContext(context);
        return context;
      } catch (error) {
        console.warn('Failed to fetch register context, using cached:', error);
        return getOfflineRegisterContext();
      }
    },
    enabled: !!organizationId && !!registerId,
  });

  // ========== OFFLINE STORAGE HELPERS ==========
  
  const getOfflineSession = (): OfflineSession | null => {
    try {
      const stored = localStorage.getItem(OFFLINE_SESSION_KEY);
      if (!stored) return null;
      const session = JSON.parse(stored) as OfflineSession;
      if (session.register_id !== registerId || session.organization_id !== organizationId) {
        return null;
      }
      return session;
    } catch {
      return null;
    }
  };

  const saveOfflineSession = (session: OfflineSession | null) => {
    if (session) {
      localStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(OFFLINE_SESSION_KEY);
    }
  };

  const getOfflineRegisterSettings = (): RegisterSettings | null => getOfflineRegisterContext();

  const getOfflineCashiers = (): Cashier[] => {
    try {
      const stored = localStorage.getItem(`${OFFLINE_CASHIERS_KEY}_${registerId}`);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  };

  const saveOfflineCashiers = (cashiers: Cashier[]) => {
    localStorage.setItem(`${OFFLINE_CASHIERS_KEY}_${registerId}`, JSON.stringify(cashiers));
  };

  // ========== REGISTER SETTINGS QUERY ==========
  
  const registerSettings = registerContext ?? getOfflineRegisterSettings();

  // ========== ASSIGNED CASHIERS QUERY ==========
  
  const { data: assignedCashiers = [] } = useQuery({
    queryKey: ['register-cashiers-offline', organizationId, registerId],
    queryFn: async (): Promise<Cashier[]> => {
      if (!organizationId || !registerId) return [];
      
      const isOnline = syncManager.checkOnline();
      
      if (isOnline) {
        try {
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
          
          const cashiers = (data || [])
            .map((d: { cashier: Cashier | null }) => d.cashier)
            .filter((c): c is Cashier => c !== null && c.is_active);
          
          // Cache for offline use
          saveOfflineCashiers(cashiers);
          return cashiers;
        } catch (error) {
          console.warn('Failed to fetch cashiers, using cached:', error);
          return getOfflineCashiers();
        }
      } else {
        return getOfflineCashiers();
      }
    },
    enabled: !!organizationId && !!registerId,
  });

  // ========== ACTIVE SESSION QUERY ==========
  
  const { data: activeSession, isLoading: isLoadingSession, refetch: refetchSession } = useQuery({
    queryKey: ['pos-active-session-offline', organizationId, registerContext?.business_id, registerContext?.branch_id, registerId],
    queryFn: async (): Promise<OfflineSession | null> => {
      if (!organizationId || !registerId) return null;
      
      const isOnline = syncManager.checkOnline();
      
      if (isOnline) {
        try {
          const { data, error } = await supabase
            // SCOPE-EXEMPT: terminal session lookup by register_id (already company-scoped via register)
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
            .eq('business_id', registerContext.business_id)
            .eq('branch_id', registerContext.branch_id)
            .eq('register_id', registerId)
            .eq('status', 'active')
            .is('ended_at', null)
            .maybeSingle();

          if (error) throw error;
          
          // Cache the session for offline use
          if (data) {
            saveOfflineSession(data as OfflineSession);
          }
          
          return data as OfflineSession | null;
        } catch (error) {
          console.warn('Failed to fetch session online, using cached:', error);
          return getOfflineSession();
        }
      } else {
        return getOfflineSession();
      }
    },
    enabled: !!organizationId && !!registerId && !!registerContext?.business_id && !!registerContext?.branch_id,
    refetchInterval: 30000,
  });

  // ========== REAL-TIME SUBSCRIPTIONS (ONLY WHEN ONLINE) ==========
  
  useEffect(() => {
    if (!organizationId || !registerId) return;
    
    // Only subscribe when online
    if (!syncManager.checkOnline()) return;

    const channel = supabase
      .channel(`terminal-session-offline-${registerId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pos_sessions',
          filter: `register_id=eq.${registerId}`,
        },
        (payload) => {
          if (payload.eventType === 'UPDATE') {
            const newData = payload.new as OfflineSession;
            
            if (newData.status === 'ended') {
              toast({
                title: 'Session Ended',
                description: 'Your session has been terminated.',
                variant: 'destructive',
              });
            } else if (newData.locked_at && !activeSession?.locked_at) {
              toast({
                title: 'Terminal Locked',
                description: newData.lock_reason || 'Terminal has been locked.',
              });
            }
          }
          
          queryClient.invalidateQueries({ queryKey: ['pos-active-session-offline'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [organizationId, registerId, queryClient, toast, activeSession?.locked_at]);

  // ========== LOGIN MUTATION ==========
  
  const loginMutation = useMutation({
    mutationFn: async ({ cashierId, registerId, pin }: CreateSessionParams) => {
      const isOnline = syncManager.checkOnline();
      const context = registerContext ?? getOfflineRegisterContext();
      if (!context?.business_id || !context?.branch_id) {
        throw new Error('Register context unavailable. Reconnect and refresh this terminal.');
      }
      
      if (isOnline) {
        // Online flow
        const { data: pinValid, error: pinError } = await supabase
          .rpc('verify_cashier_pin', { 
            p_cashier_id: cashierId, 
            p_pin: pin 
          });

        if (pinError) throw pinError;
        if (!pinValid) throw new Error('Invalid PIN');

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

        // End any existing active sessions for this cashier
        await supabase
          .from('pos_sessions')
          .update({ 
            status: 'ended', 
            ended_at: new Date().toISOString(),
            lock_reason: 'New session started'
          })
          .eq('cashier_id', cashierId)
          .eq('status', 'active');

        const { data: session, error: sessionError } = await supabase
          .from('pos_sessions')
          .insert({
            cashier_id: cashierId,
            register_id: registerId,
            organization_id: context.organization_id,
            business_id: context.business_id,
            branch_id: context.branch_id,
            status: 'active',
          })
          .select()
          .single();

        if (sessionError) throw sessionError;

        return { session, cashier, isOffline: false };
      } else if (isElectron()) {
        // Offline flow - use TerminalLockService
        const result = await terminalLockService.unlockWithPin(pin, organizationId!);
        
        if (!result.success || !result.cashier) {
          throw new Error(result.error || 'Invalid PIN');
        }

        const offlineSession: OfflineSession = {
          id: `offline-${Date.now()}`,
          cashier_id: result.cashier.id,
          register_id: registerId!,
          organization_id: context.organization_id,
          business_id: context.business_id,
          branch_id: context.branch_id,
          status: 'active',
          locked_at: null,
          lock_reason: null,
          session_type: 'cashier',
          cashier: {
            id: result.cashier.id,
            display_name: result.cashier.displayName,
            employee_number: result.cashier.employeeNumber,
            user_id: null,
            max_discount_percent: null,
            max_void_amount: null,
            can_apply_discounts: result.cashier.permissions.includes('can_apply_discounts'),
            can_void_transactions: result.cashier.permissions.includes('can_void_transactions'),
            can_process_returns: result.cashier.permissions.includes('can_process_returns'),
            can_open_cash_drawer: result.cashier.permissions.includes('can_open_cash_drawer'),
          },
        };

        saveOfflineSession(offlineSession);
        
        return { 
          session: offlineSession, 
          cashier: offlineSession.cashier,
          isOffline: true 
        };
      } else {
        throw new Error('No network connection and offline mode not available');
      }
    },
    onSuccess: (data) => {
      const sessionData = {
        ...data.session,
        cashier: data.cashier,
      };
      queryClient.setQueryData(['pos-active-session-offline', organizationId, registerContext?.business_id, registerContext?.branch_id, registerId], sessionData);
      
      toast({
        title: data.isOffline ? 'Logged In (Offline)' : 'Logged In',
        description: `Welcome, ${data.cashier?.display_name || 'Cashier'}`,
      });
    },
    onError: (error: Error) => {
      const n = normalizeError(error);
      toast({
        title: n.title === 'Something went wrong' ? 'Login Failed' : n.title,
        description: n.message,
        variant: 'destructive',
      });
    },
  });

  // ========== LOCK SESSION MUTATION ==========
  
  const lockSessionMutation = useMutation({
    mutationFn: async (reason?: string) => {
      if (!activeSession?.id) throw new Error('No active session');

      const isOnline = syncManager.checkOnline();

      if (isOnline && !activeSession.id.startsWith('offline-')) {
        const { error } = await supabase
          .from('pos_sessions')
          .update({ 
            locked_at: new Date().toISOString(), 
            lock_reason: reason || 'Manual lock' 
          })
          .eq('id', activeSession.id);

        if (error) throw error;
      }
      
      // Always update local state
      const lockedSession = {
        ...activeSession,
        locked_at: new Date().toISOString(),
        lock_reason: reason || 'Manual lock',
      };
      saveOfflineSession(lockedSession);
      
      if (isElectron()) {
        terminalLockService.lock();
      }
      
      return lockedSession;
    },
    onSuccess: (lockedSession) => {
      queryClient.setQueryData(['pos-active-session-offline', organizationId, activeSession.business_id, activeSession.branch_id, registerId], lockedSession);
      toast({
        title: 'Terminal Locked',
        description: 'Enter PIN to unlock',
      });
    },
  });

  // ========== UNLOCK SESSION MUTATION ==========
  
  const unlockSessionMutation = useMutation({
    mutationFn: async (pin: string) => {
      if (!activeSession?.id) throw new Error('No active session');

      const isOnline = syncManager.checkOnline();
      const isManagerSession = !activeSession.cashier_id || activeSession.session_type === 'manager';

      if (isOnline && !activeSession.id.startsWith('offline-')) {
        if (isManagerSession) {
          // Manager PINs are company-scoped; use the active session company.
          const { data: managerPins } = await supabase
            .from('pos_manager_pins')
            .select('user_id')
            .eq('organization_id', organizationId!)
            .eq('business_id', activeSession.business_id)
            .eq('is_active', true);

          let pinValid = false;
          if (managerPins) {
            for (const manager of managerPins) {
              const { data: isValid } = await supabase
                .rpc('verify_manager_pin' as any, { 
                  p_organization_id: organizationId!,
                  p_business_id: activeSession.business_id,
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
      } else if (isElectron()) {
        const result = await terminalLockService.unlockWithPin(pin, organizationId!);
        if (!result.success) {
          throw new Error(result.error || 'Invalid PIN');
        }
      } else {
        throw new Error('Cannot verify PIN offline');
      }
      
      const unlockedSession = {
        ...activeSession,
        locked_at: null,
        lock_reason: null,
      };
      saveOfflineSession(unlockedSession);
      
      return unlockedSession;
    },
    onSuccess: (unlockedSession) => {
      queryClient.setQueryData(['pos-active-session-offline', organizationId, activeSession.business_id, activeSession.branch_id, registerId], unlockedSession);
      toast({
        title: 'Terminal Unlocked',
      });
    },
    onError: (error: Error) => {
      const n = normalizeError(error);
      toast({
        title: n.title === 'Something went wrong' ? 'Unlock Failed' : n.title,
        description: n.message,
        variant: 'destructive',
      });
    },
  });

  // ========== LOGOUT MUTATION ==========
  
  const logoutMutation = useMutation({
    mutationFn: async () => {
      if (!activeSession?.id) throw new Error('No active session');

      const isOnline = syncManager.checkOnline();

      if (isOnline && !activeSession.id.startsWith('offline-')) {
        const { error } = await supabase
          .from('pos_sessions')
          .update({ 
            status: 'ended', 
            ended_at: new Date().toISOString() 
          })
          .eq('id', activeSession.id);

        if (error) throw error;
      }
      
      saveOfflineSession(null);
      
      if (isElectron()) {
        terminalLockService.lock();
      }
    },
    onSuccess: () => {
      queryClient.setQueryData(['pos-active-session-offline', organizationId, activeSession.business_id, activeSession.branch_id, registerId], null);
      queryClient.invalidateQueries({ queryKey: ['pos-active-session-offline'] });
      toast({
        title: 'Logged Out',
        description: 'Session ended successfully',
      });
    },
  });

  // ========== MANAGER LOGIN MUTATION ==========
  
  const managerLoginMutation = useMutation({
    mutationFn: async ({ registerId, pin, organizationId }: ManagerLoginParams) => {
      const isOnline = syncManager.checkOnline();
      const context = registerContext ?? getOfflineRegisterContext();
      if (!context?.business_id || !context?.branch_id) {
        throw new Error('Register context unavailable. Reconnect and refresh this terminal.');
      }
      
      if (!isOnline) {
        if (isElectron()) {
          const managers = await terminalLockService.getManagers(organizationId);
          if (managers.length === 0) {
            throw new Error('No managers configured for offline access');
          }
          
          for (const manager of managers) {
            const result = await terminalLockService.unlockWithManagerOverride(
              manager.id,
              pin,
              organizationId,
              'Manager login'
            );
            
            if (result.success) {
              const offlineSession: OfflineSession = {
                id: `offline-manager-${Date.now()}`,
                cashier_id: null,
                register_id: registerId,
                organization_id: context.organization_id,
                business_id: context.business_id,
                branch_id: context.branch_id,
                status: 'active',
                locked_at: null,
                lock_reason: null,
                session_type: 'manager',
                cashier: {
                  id: 'manager',
                  display_name: result.cashier?.displayName || 'Manager',
                  employee_number: null,
                  user_id: null,
                  max_discount_percent: 100,
                  max_void_amount: null,
                  can_apply_discounts: true,
                  can_void_transactions: true,
                  can_process_returns: true,
                  can_open_cash_drawer: true,
                },
              };
              
              saveOfflineSession(offlineSession);
              return { session: offlineSession, isManager: true, managerName: result.cashier?.displayName || 'Manager', isOffline: true };
            }
          }
          throw new Error('Invalid manager PIN');
        } else {
          throw new Error('No network connection');
        }
      }

      // Online flow
      // Manager PINs are company-scoped; use the register context company.
      const { data: managerPins, error: pinsError } = await supabase
        .from('pos_manager_pins')
        .select('user_id')
        .eq('organization_id', organizationId)
        .eq('business_id', context.business_id)
        .eq('is_active', true);

      if (pinsError) throw pinsError;
      if (!managerPins || managerPins.length === 0) {
        throw new Error('No manager PINs configured for this organization');
      }

      let validManagerId: string | null = null;
      for (const manager of managerPins) {
        const { data: isValid } = await supabase
          .rpc('verify_manager_pin' as any, { 
            p_organization_id: organizationId,
            p_business_id: context.business_id,
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

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('user_id', validManagerId)
        .single();

      const { data: session, error: sessionError } = await supabase
        .from('pos_sessions')
        .insert({
          cashier_id: null,
          register_id: registerId,
          organization_id: context.organization_id,
          business_id: context.business_id,
          branch_id: context.branch_id,
          status: 'active',
          session_type: 'manager',
        })
        .select()
        .single();

      if (sessionError) throw sessionError;

      return { session, isManager: true, managerName: profile?.full_name || profile?.email || 'Manager', isOffline: false };
    },
    onSuccess: (data) => {
      const sessionData = {
        ...data.session,
        cashier: {
          id: 'manager',
          display_name: data.managerName,
          employee_number: null,
          user_id: null,
        },
      };
      queryClient.setQueryData(['pos-active-session-offline', organizationId, registerContext?.business_id, registerContext?.branch_id, registerId], sessionData);
      saveOfflineSession(sessionData as OfflineSession);
      
      toast({
        title: data.isOffline ? 'Manager Access Granted (Offline)' : 'Manager Access Granted',
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

  // ========== DERIVED STATE ==========
  
  const requiresLogin = registerSettings?.require_cashier_login ?? false;
  const isLocked = !!activeSession?.locked_at;
  const hasActiveSession = !!activeSession && activeSession.status === 'active';
  const shouldShowLockScreen = requiresLogin && (!hasActiveSession || isLocked);
  const autoLockMinutes = registerSettings?.auto_lock_minutes;

  return {
    // Session state
    activeSession,
    isLoadingSession,
    assignedCashiers,
    refetchSession,
    
    // Security state
    requiresLogin,
    isLocked,
    hasActiveSession,
    shouldShowLockScreen,
    autoLockMinutes,
    
    // Login actions
    login: loginMutation.mutate,
    isLoggingIn: loginMutation.isPending,
    
    // Manager login
    managerLogin: managerLoginMutation.mutate,
    isManagerLoggingIn: managerLoginMutation.isPending,
    
    // Lock/unlock
    lockSession: lockSessionMutation.mutate,
    isLocking: lockSessionMutation.isPending,
    unlockSession: unlockSessionMutation.mutate,
    isUnlocking: unlockSessionMutation.isPending,
    
    // Logout
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
}
