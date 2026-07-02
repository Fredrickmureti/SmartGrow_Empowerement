/**
 * useScannerSession — owns the scanner_session lifecycle and the realtime
 * channel subscription independently of any dialog UI.
 *
 * Previously the QR dialog (`ScannerSessionDialog`) owned both `sessionId`
 * and the `useScanChannel({ topic })` subscription. Closing the dialog
 * dropped `sessionId` to null, which unsubscribed from `scan:session:<id>`
 * and silently broke every subsequent scan even though the phone was still
 * paired server-side.
 *
 * This hook lifts ownership into the parent that actually consumes scans
 * (e.g. `ProductIdentifiersEditor`). The channel subscription survives for
 * the lifetime of that parent, and the QR dialog becomes a presentational
 * pairing UI that can be opened/closed without disturbing the channel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useScanChannel, type ConnectedScannerDevice } from "@/hooks/pos/useScanChannel";
import { tryGetPublicAppUrl } from "@/lib/publicAppUrl";
import type { RevokeReason } from "@/services/scanner/ackPayload";

interface Pairing { token: string; expiresAt: number }

interface Options {
  enabled: boolean;
  businessId: string;
  branchId?: string | null;
  label: string;
}

export interface UseScannerSessionResult {
  sessionId: string | null;
  pairing: Pairing | null;
  secondsLeft: number;
  connectedDevices: ConnectedScannerDevice[];
  loading: boolean;
  error: string | null;
  /** Mint a fresh 60s pairing token for the active session. */
  mintPairing: () => Promise<void>;
  /** Server-side revoke + best-effort broadcast to stop the phone camera. */
  revoke: (reason?: RevokeReason) => Promise<{ ok: boolean; count: number; error?: string }>;
  /** Pairing URL for the QR code (empty until a pairing exists). */
  url: string;
  /** S5 telemetry — round-trip ping to the phone (ms or null on timeout). */
  pingPhone: () => Promise<number | null>;
  /** S5 telemetry — rolling RTT median (ms) over last 10 pings. */
  rttMedianMs: number | null;
  /** S5 telemetry — wall-clock ms of last scan received on this channel. */
  lastScanAt: number | null;
  /** Wave-6 — per-device last-scan timestamps, drives the "Active" pill. */
  lastScanByDevice: Record<string, number>;
}

export function useScannerSession({
  enabled,
  businessId,
  branchId = null,
  label,
}: Options): UseScannerSessionResult {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const topic = sessionId ? `scan:session:${sessionId}` : null;

  const {
    connectedDevices,
    revoke: channelRevoke,
    pingPhone,
    rttMedianMs,
    lastScanAt,
    lastScanByDevice,
  } = useScanChannel({
    topic,
    onRevoke: async () => {
      if (!sessionId) return { ok: false, count: 0, error: "no session" };
      const { data, error: e } = await supabase.rpc(
        "revoke_scanner_session" as any,
        { p_session_id: sessionId } as any,
      );
      if (e) return { ok: false, count: 0, error: e.message };
      return { ok: true, count: Number(data) || 0 };
    },
  });

  const mintPairing = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    const { data, error: e } = await supabase.rpc(
      "create_scanner_session_pairing" as any,
      { p_session_id: sessionId } as any,
    );
    if (e || !Array.isArray(data) || data.length === 0) {
      setError(e?.message || "Failed to mint pairing");
      return;
    }
    const row = data[0] as any;
    setPairing({ token: row.token, expiresAt: new Date(row.expires_at).getTime() });
  }, [sessionId]);

  // Open the session once when enabled flips to true; close (revoke) when
  // the hook unmounts or `enabled` flips false without ever having paired.
  const sessionIdRef = useRef<string | null>(null);
  const connectedRef = useRef(false);
  const creatingRef = useRef(false);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { connectedRef.current = connectedDevices.length > 0; }, [connectedDevices]);

  useEffect(() => {
    if (!enabled || !businessId) return;
    if (sessionIdRef.current || creatingRef.current) return;
    let cancelled = false;
    creatingRef.current = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: e } = await supabase.rpc("create_scanner_session" as any, {
        p_business_id: businessId,
        p_branch_id: branchId ?? null,
        p_label: label,
        p_target_kind: "session",
      } as any);
      if (cancelled) return;
      if (e || !Array.isArray(data) || data.length === 0) {
        setLoading(false);
        creatingRef.current = false;
        setError(e?.message || "Failed to create scanner session");
        return;
      }
      const sid = (data[0] as any).id as string;
      setSessionId(sid);
      // mint first pairing token
      const { data: pd, error: pe } = await supabase.rpc(
        "create_scanner_session_pairing" as any,
        { p_session_id: sid } as any,
      );
      if (cancelled) return;
      if (!pe && Array.isArray(pd) && pd.length > 0) {
        const row = pd[0] as any;
        setPairing({ token: row.token, expiresAt: new Date(row.expires_at).getTime() });
      } else if (pe) {
        setError(pe.message);
      }
      setLoading(false);
      creatingRef.current = false;
    })();
    return () => { cancelled = true; creatingRef.current = false; };
  }, [enabled, businessId, branchId, label]);

  // Final safety net: if hook unmounts and no phone ever paired, revoke
  // server-side so a leftover pairing token can't later inject scans.
  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (sid && !connectedRef.current) {
        void supabase.rpc("revoke_scanner_session" as any, { p_session_id: sid } as any);
      }
    };
  }, []);

  // Pairing-token countdown.
  useEffect(() => {
    if (!pairing) { setSecondsLeft(0); return; }
    const tick = () => setSecondsLeft(
      Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000)),
    );
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [pairing]);

  const base = tryGetPublicAppUrl();
  const url = pairing && base ? `${base}/scan/${pairing.token}` : "";

  return {
    sessionId,
    pairing,
    secondsLeft,
    connectedDevices,
    loading,
    error,
    mintPairing,
    revoke: channelRevoke,
    url,
    pingPhone,
    rttMedianMs,
    lastScanAt,
    lastScanByDevice,
  };
}
