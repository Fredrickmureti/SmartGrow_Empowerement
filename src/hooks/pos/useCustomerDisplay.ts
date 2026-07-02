import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { hardwareClient, type CustomerDisplayData } from '@/services/hardware/HardwareClient';

interface Display {
  id: number;
  label: string;
  primary: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

interface UseCustomerDisplayReturn {
  isAvailable: boolean;
  isConnected: boolean;
  displays: Display[];
  isLoading: boolean;
  error: string | null;
  open: (displayIndex?: number, fullscreen?: boolean) => Promise<boolean>;
  close: () => Promise<boolean>;
  update: (data: CustomerDisplayData) => Promise<boolean>;
  showMessage: (message: string) => Promise<boolean>;
  showComplete: (total: number, customerName?: string) => Promise<boolean>;
  reset: () => Promise<boolean>;
  refreshDisplays: () => Promise<void>;
}

/**
 * Hook for managing the customer-facing display on a secondary screen.
 * Routes everything through `hardwareClient.customerDisplay.*` so neither
 * components nor this hook depend on the legacy `customerDisplayService`.
 * Works in Electron (real BrowserWindow IPC) and in browser preview
 * (popup window + postMessage).
 */
export function useCustomerDisplay(): UseCustomerDisplayReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [displays, setDisplays] = useState<Display[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAvailable = hardwareClient.customerDisplay.isAvailable();

  const refreshDisplays = useCallback(async () => {
    try {
      const availableDisplays = await hardwareClient.customerDisplay.getDisplays();
      setDisplays(availableDisplays);
    } catch (err) {
      console.error('Failed to get displays:', err);
    }
  }, []);

  // Liveness: poll `isOpen()` on mount + on hardware-event push. The 1 s
  // setInterval the legacy hook ran is gone — that loop was the
  // observability anti-pattern the H4 plan called out. We resync on the
  // events the bus actually emits, plus a 10 s safety tick to catch the
  // rare case the popup is closed via the OS chrome (no postMessage).
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const open = await hardwareClient.customerDisplay.isOpen();
        if (!cancelled) setIsConnected(open);
      } catch { /* ignore */ }
    };
    refreshDisplays();
    sync();

    const offConn = hardwareClient.on('device:connected', () => sync());
    const offDisc = hardwareClient.on('device:disconnected', () => sync());
    const offDispUpd = hardwareClient.on('display:updated', () => sync());
    const offDispDc = hardwareClient.on('display:disconnected', () => sync());

    const safety = setInterval(sync, 10_000);

    return () => {
      cancelled = true;
      offConn();
      offDisc();
      offDispUpd();
      offDispDc();
      clearInterval(safety);
    };
  }, [refreshDisplays]);

  const open = useCallback(async (displayIndex = 1, fullscreen = true): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      // Refresh the display list first so we know how many monitors are
      // actually attached. Only warn under Electron when the operator
      // asked for a *secondary* display and only one monitor exists —
      // that's the case where landing on primary is surprising. The web
      // popup path always lands in a popup window, so the toast there
      // is noise.
      const list = await hardwareClient.customerDisplay.getDisplays().catch(() => []);
      const isElectron = Boolean((window as unknown as { pos?: { isElectron?: boolean } }).pos?.isElectron);
      if (isElectron && displayIndex >= 1 && list.length === 1) {
        toast.info('Single display detected — opening customer display in a small window on this screen.');
      }

      const result = await hardwareClient.customerDisplay.open({ enabled: true, displayIndex, fullscreen });
      if (result.success) {
        setIsConnected(true);
        await refreshDisplays();
        return true;
      }
      const msg = result.error || 'Failed to open display';
      setError(msg);
      toast.error(msg);
      return false;
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(msg);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [refreshDisplays]);

  const close = useCallback(async (): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await hardwareClient.customerDisplay.close();
      if (result.success) {
        setIsConnected(false);
        return true;
      }
      setError(result.error || 'Failed to close display');
      return false;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const update = useCallback(async (data: CustomerDisplayData): Promise<boolean> => {
    if (!isConnected) {
      setError('Display not connected');
      return false;
    }
    try {
      const result = await hardwareClient.customerDisplay.update(data);
      if (!result.success) {
        setError(result.error || 'Failed to update display');
        return false;
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, [isConnected]);

  const showMessage = useCallback(async (message: string): Promise<boolean> => {
    try {
      const result = await hardwareClient.customerDisplay.showMessage(message);
      return result.success;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, []);

  const showComplete = useCallback(async (total: number, customerName?: string): Promise<boolean> => {
    try {
      const result = await hardwareClient.customerDisplay.showComplete(total, customerName);
      return result.success;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, []);

  const reset = useCallback(async (): Promise<boolean> => {
    try {
      const result = await hardwareClient.customerDisplay.reset();
      return result.success;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, []);

  return {
    isAvailable,
    isConnected,
    displays,
    isLoading,
    error,
    open,
    close,
    update,
    showMessage,
    showComplete,
    reset,
    refreshDisplays,
  };
}

export default useCustomerDisplay;
