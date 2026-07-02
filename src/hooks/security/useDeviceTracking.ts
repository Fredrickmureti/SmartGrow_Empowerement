import { normalizeError } from "@/services/resilience";
/**
 * Device Tracking Hook
 * Manages device registration, login tracking, and security alerts
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { getDeviceInfo, getDeviceIdentifier } from '@/services/security/DeviceFingerprintService';

export interface UserDevice {
  id: string;
  user_id: string;
  device_fingerprint: string;
  device_name: string | null;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  os_version: string | null;
  device_type: 'desktop' | 'mobile' | 'tablet' | 'unknown' | null;
  ip_address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  is_trusted: boolean;
  trust_expires_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  session_count: number;
  is_current: boolean;
}

export interface LoginHistoryEntry {
  id: string;
  user_id: string | null;
  device_id: string | null;
  email: string | null;
  ip_address: string | null;
  city: string | null;
  country: string | null;
  login_method: string;
  status: string;
  failure_reason: string | null;
  is_new_device: boolean;
  is_new_location: boolean;
  risk_score: number | null;
  created_at: string;
}

export interface SecurityAlert {
  id: string;
  user_id: string;
  alert_type: string;
  severity: string;
  title: string;
  message: string;
  is_read: boolean;
  is_resolved: boolean;
  created_at: string;
}

export function useDeviceTracking() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch user's devices
  const {
    data: devices,
    isLoading: isLoadingDevices,
    refetch: refetchDevices,
  } = useQuery({
    queryKey: ['user-devices', user?.id],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase
        .from('user_devices')
        .select('*')
        .eq('user_id', user.id)
        .order('last_seen_at', { ascending: false });

      if (error) throw error;
      return data as UserDevice[];
    },
    enabled: !!user,
  });

  // Fetch login history
  const {
    data: loginHistory,
    isLoading: isLoadingHistory,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: ['login-history', user?.id],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase
        .from('login_history')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as LoginHistoryEntry[];
    },
    enabled: !!user,
  });

  // Fetch unread security alerts
  const {
    data: alerts,
    isLoading: isLoadingAlerts,
    refetch: refetchAlerts,
  } = useQuery({
    queryKey: ['security-alerts', user?.id],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase
        .from('security_alerts')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_read', false)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as SecurityAlert[];
    },
    enabled: !!user,
  });

  // Get current device fingerprint
  const {
    data: currentDeviceInfo,
    isLoading: isLoadingCurrentDevice,
  } = useQuery({
    queryKey: ['current-device-info'],
    queryFn: async () => {
      return getDeviceInfo();
    },
    staleTime: Infinity, // Device info doesn't change
  });

  // Record login mutation
  const recordLoginMutation = useMutation({
    mutationFn: async (loginMethod: string = 'password') => {
      const deviceInfo = await getDeviceInfo();
      
      // Get IP geolocation (using free API)
      let geoData: any = {};
      try {
        const geoResponse = await fetch('https://ipapi.co/json/');
        if (geoResponse.ok) {
          geoData = await geoResponse.json();
        }
      } catch (e) {
        console.warn('Could not fetch geolocation:', e);
      }

      const { data, error } = await supabase.rpc('record_device_login', {
        p_device_fingerprint: deviceInfo.fingerprint,
        p_device_name: deviceInfo.deviceName,
        p_browser: deviceInfo.browser,
        p_browser_version: deviceInfo.browserVersion,
        p_os: deviceInfo.os,
        p_os_version: deviceInfo.osVersion,
        p_device_type: deviceInfo.deviceType,
        p_ip_address: geoData.ip || null,
        p_city: geoData.city || null,
        p_region: geoData.region || null,
        p_country: geoData.country_name || null,
        p_country_code: geoData.country_code || null,
        p_latitude: geoData.latitude || null,
        p_longitude: geoData.longitude || null,
        p_login_method: loginMethod,
        p_user_agent: deviceInfo.userAgent,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['user-devices'] });
      queryClient.invalidateQueries({ queryKey: ['login-history'] });

      // Show alert for new device or location
      if (data?.is_new_device) {
        toast({
          title: 'New Device Detected',
          description: 'This login is from a new device. Check your security settings if this wasn\'t you.',
          variant: 'default',
        });
      } else if (data?.is_new_location) {
        toast({
          title: 'New Location Detected',
          description: 'This login is from a new location. Verify your recent activity if unexpected.',
          variant: 'default',
        });
      }
    },
    onError: (error: Error) => {
      console.error('Failed to record login:', error);
    },
  });

  // Trust device mutation
  const trustDeviceMutation = useMutation({
    mutationFn: async ({ deviceId, trustDays = 30 }: { deviceId: string; trustDays?: number }) => {
      const { data, error } = await supabase.rpc('trust_device', {
        p_device_id: deviceId,
        p_trust_days: trustDays,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-devices'] });
      toast({
        title: 'Device Trusted',
        description: 'This device has been marked as trusted.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: normalizeError(error).message,
        variant: 'destructive',
      });
    },
  });

  // Remove device mutation
  const removeDeviceMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      const { data, error } = await supabase.rpc('remove_device', {
        p_device_id: deviceId,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-devices'] });
      queryClient.invalidateQueries({ queryKey: ['user-pins'] });
      toast({
        title: 'Device Removed',
        description: 'The device has been removed and logged out.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: normalizeError(error).message,
        variant: 'destructive',
      });
    },
  });

  // Mark alert as read mutation
  const markAlertReadMutation = useMutation({
    mutationFn: async (alertId: string) => {
      const { data, error } = await supabase.rpc('mark_alert_read', {
        p_alert_id: alertId,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-alerts'] });
    },
  });

  // Get current device
  const currentDevice = devices?.find(d => d.is_current);

  return {
    // Data
    devices,
    loginHistory,
    alerts,
    currentDevice,
    currentDeviceInfo,
    unreadAlertCount: alerts?.length || 0,

    // Loading states
    isLoadingDevices,
    isLoadingHistory,
    isLoadingAlerts,
    isLoadingCurrentDevice,

    // Refetch functions
    refetchDevices,
    refetchHistory,
    refetchAlerts,

    // Mutations
    recordLogin: recordLoginMutation.mutate,
    isRecordingLogin: recordLoginMutation.isPending,

    trustDevice: trustDeviceMutation.mutate,
    isTrustingDevice: trustDeviceMutation.isPending,

    removeDevice: removeDeviceMutation.mutate,
    isRemovingDevice: removeDeviceMutation.isPending,

    markAlertRead: markAlertReadMutation.mutate,
  };
}

/**
 * Hook to get just the current device fingerprint
 */
export function useDeviceFingerprint() {
  const { data: fingerprint, isLoading } = useQuery({
    queryKey: ['device-fingerprint'],
    queryFn: getDeviceIdentifier,
    staleTime: Infinity,
  });

  return { fingerprint, isLoading };
}
