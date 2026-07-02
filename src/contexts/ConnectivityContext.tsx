/**
 * ConnectivityContext
 *
 * Thin React wrapper around the singleton `connectivityManager` so
 * components subscribe declaratively. Mount `<ConnectivityProvider />`
 * once near the app root.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  connectivityManager,
  type ConnectivityStatus,
  type RealtimeState,
} from "@/services/resilience/ConnectivityManager";
import { normalizeError, type NormalizedError } from "@/services/resilience/ErrorNormalizer";

interface ConnectivityContextValue {
  status: ConnectivityStatus;
  realtime: RealtimeState;
  isOnline: boolean;
  isOffline: boolean;
  isDegraded: boolean;
  /** True only when realtime has been disconnected past the grace window AND we're not already offline (which would dominate UI). */
  isRealtimeDegraded: boolean;
  /** Timestamp (ms) of the most recent verified-online moment, or null. */
  lastOnlineAt: number | null;
  /** Normalize any thrown value, pre-seeded with the current status. */
  normalize: (err: unknown) => NormalizedError;
  /** Force a server probe to recover from `degraded`. */
  probe: () => Promise<boolean>;
}

const ConnectivityContext = createContext<ConnectivityContextValue | null>(null);

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectivityStatus>(() => connectivityManager.getStatus());
  const [realtime, setRealtime] = useState<RealtimeState>(() => connectivityManager.getRealtimeState());
  const [realtimeDegraded, setRealtimeDegraded] = useState<boolean>(false);

  useEffect(() => {
    // Configure probe URL from the publishable Supabase URL when available.
    const url = (import.meta as unknown as { env?: { VITE_SUPABASE_URL?: string } }).env?.VITE_SUPABASE_URL;
    if (url) connectivityManager.setProbeUrl(`${url}/auth/v1/health`);

    const offStatus = connectivityManager.subscribe((next) => {
      setStatus(next);
      // Re-evaluate realtime gate on every connectivity transition;
      // recovery in the manager already collapses the gate.
      setRealtimeDegraded(connectivityManager.isRealtimeDegraded());
    });
    const offRealtime = connectivityManager.subscribeRealtime((next) => {
      setRealtime(next);
      setRealtimeDegraded(connectivityManager.isRealtimeDegraded());
    });

    // Poll the degraded gate every 5s so the grace window can elapse
    // without producing a 2s flicker cadence during transitions.
    const timer = window.setInterval(() => {
      setRealtimeDegraded(connectivityManager.isRealtimeDegraded());
    }, 5_000);

    return () => { offStatus(); offRealtime(); window.clearInterval(timer); };
  }, []);

  const value: ConnectivityContextValue = {
    status,
    realtime,
    isOnline: status === "online",
    isOffline: status === "offline",
    isDegraded: status === "degraded",
    isRealtimeDegraded: status === "online" && realtimeDegraded,
    lastOnlineAt: connectivityManager.getLastOnlineAt(),
    normalize: (err) => normalizeError(err, { connectivity: status }),
    probe: () => connectivityManager.probe(),
  };

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): ConnectivityContextValue {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) {
    const status = connectivityManager.getStatus();
    const realtime = connectivityManager.getRealtimeState();
    return {
      status,
      realtime,
      isOnline: status === "online",
      isOffline: status === "offline",
      isDegraded: status === "degraded",
      isRealtimeDegraded: status === "online" && connectivityManager.isRealtimeDegraded(),
      lastOnlineAt: connectivityManager.getLastOnlineAt(),
      normalize: (err) => normalizeError(err, { connectivity: status }),
      probe: () => connectivityManager.probe(),
    };
  }
  return ctx;
}
