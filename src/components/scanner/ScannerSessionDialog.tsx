/**
 * ScannerSessionDialog — QR-pairing dialog for any onboarding workflow.
 *
 * Supports two modes:
 *   1. Self-managed (default): creates and owns its own scanner_session for
 *      the lifetime of the dialog. Used by `ScannerPairingButton` callers
 *      where the channel doesn't need to outlive the dialog (e.g. inventory
 *      receiving where scans only matter while the user is on that screen).
 *   2. Controlled: parent passes a `session` object from `useScannerSession`.
 *      The dialog becomes purely presentational — closing it does NOT tear
 *      down the channel. Used by `ProductIdentifiersEditor` so scans keep
 *      flowing into the editor after the QR is dismissed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Smartphone, RefreshCw, CheckCircle2, Loader2, ScanLine, Ban, Activity, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { tryGetPublicAppUrl } from "@/lib/publicAppUrl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useScanChannel, type ConnectedScannerDevice } from "@/hooks/pos/useScanChannel";
import type { UseScannerSessionResult } from "@/hooks/scanner/useScannerSession";
import { DevicePresenceList } from "@/components/scanner/DevicePresenceList";
import { useIsLikelyMobile } from "@/hooks/useIsLikelyMobile";
import { InAppQrScanner } from "@/components/scanner/InAppQrScanner";
import { useNavigate } from "react-router-dom";
import { Camera } from "lucide-react";
import { DeviceModeChoice } from "@/components/scanner/DeviceModeChoice";


interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active business id (required when self-managing). */
  businessId: string;
  /** Branch scope. Null = HQ-wide session, restricted to user's branches. */
  branchId?: string | null;
  /** Short human label e.g. "Product onboarding — Maria". */
  label: string;
  /** Called whenever a session is created — caller decides routing. */
  onSessionReady?: (sessionId: string) => void;
  /**
   * Controlled mode: when provided, the dialog uses this session instead of
   * creating its own. Closing the dialog will not revoke or unsubscribe.
   */
  session?: UseScannerSessionResult;
  /**
   * Stage 5 (POS scanner re-audit) — session lifecycle mode:
   *  - "modal"      (default): self-managed session, torn down on close.
   *                 Use for short-lived flows (POS pairing, receiving) where
   *                 scans only matter while the dialog is open.
   *  - "persistent": controlled session, MUST pass `session` from
   *                 `useScannerSession()`. The channel survives dialog
   *                 close, so onboarding screens keep receiving scans after
   *                 the QR is dismissed. Throws in dev if `session` is
   *                 missing, preventing accidental data-loss bugs.
   */
  mode?: "modal" | "persistent";
}

interface Pairing { token: string; expiresAt: number }

export function ScannerSessionDialog({
  open,
  onOpenChange,
  businessId,
  branchId,
  label,
  onSessionReady,
  session,
  mode = "modal",
}: Props) {
  if (mode === "persistent") {
    if (!session) {
      // In dev this surfaces immediately; in prod we fall back gracefully
      // to self-managed mode rather than crash the page, but log loudly.
      const msg = "[ScannerSessionDialog] mode=\"persistent\" requires a `session` prop from useScannerSession(). Falling back to self-managed mode — scans will stop when the dialog closes.";
      if (process.env.NODE_ENV !== "production") {
        throw new Error(msg);
      }
      console.error(msg);
    } else {
      return (
        <ControlledDialog open={open} onOpenChange={onOpenChange} session={session} label={label} />
      );
    }
  } else if (session) {
    // Back-compat: existing callers that pass `session` without `mode` keep
    // controlled behavior.
    return (
      <ControlledDialog open={open} onOpenChange={onOpenChange} session={session} label={label} />
    );
  }
  return (
    <SelfManagedDialog
      open={open}
      onOpenChange={onOpenChange}
      businessId={businessId}
      branchId={branchId}
      label={label}
      onSessionReady={onSessionReady}
    />
  );
}


/* --------------------------- Controlled mode --------------------------- */

function ControlledDialog({
  open,
  onOpenChange,
  session,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: UseScannerSessionResult;
  label: string;
}) {
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const { pairing, secondsLeft, connectedDevices, loading, error, mintPairing, revoke, url, sessionId } =
    session;
  const isConnected = connectedDevices.length > 0;

  const handleRevoke = async () => {
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await revoke();
      if (!res.ok) setRevokeError(res.error || "Failed to disconnect");
      else onOpenChange(false);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" /> Use phone as scanner
          </DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>
        <DeviceModeChoice label={label} onUseThisDevice={() => onOpenChange(false)} />

        <SessionBody
          isConnected={isConnected}
          loading={loading}
          pairing={pairing}
          url={url}
          secondsLeft={secondsLeft}
          error={error || revokeError}
          connectedDevices={connectedDevices}
          revoking={revoking}
          onRefreshPairing={() => sessionId && mintPairing()}
          onRevoke={handleRevoke}
          onDone={() => onOpenChange(false)}
          pingPhone={session.pingPhone}
          rttMedianMs={session.rttMedianMs}
          lastScanAt={session.lastScanAt}
          lastScanByDevice={session.lastScanByDevice}
          sessionId={sessionId}
          label={label}
        />
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------- Self-managed mode -------------------------- */

function SelfManagedDialog({
  open,
  onOpenChange,
  businessId,
  branchId,
  label,
  onSessionReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessId: string;
  branchId?: string | null;
  label: string;
  onSessionReady?: (sessionId: string) => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [revoking, setRevoking] = useState(false);

  const topic = useMemo(() => (sessionId ? `scan:session:${sessionId}` : null), [sessionId]);

  const { connectedDevices, revoke, lastScanByDevice } = useScanChannel({
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

  const openSession = async () => {
    setLoading(true);
    setError(null);
    const { data, error: e } = await supabase.rpc("create_scanner_session" as any, {
      p_business_id: businessId,
      p_branch_id: branchId ?? null,
      p_label: label,
      p_target_kind: "session",
    } as any);
    if (e || !Array.isArray(data) || data.length === 0) {
      setLoading(false);
      setError(e?.message || "Failed to create scanner session");
      return;
    }
    const sid = (data[0] as any).id as string;
    setSessionId(sid);
    onSessionReady?.(sid);
    await mintPairing(sid);
    setLoading(false);
  };

  const mintPairing = async (sid: string) => {
    setError(null);
    const { data, error: e } = await supabase.rpc("create_scanner_session_pairing" as any, {
      p_session_id: sid,
    } as any);
    if (e || !Array.isArray(data) || data.length === 0) {
      setError(e?.message || "Failed to mint pairing");
      return;
    }
    const row = data[0] as any;
    setPairing({ token: row.token, expiresAt: new Date(row.expires_at).getTime() });
  };

  const sessionIdRef = useRef<string | null>(null);
  const connectedRef = useRef(connectedDevices.length > 0);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { connectedRef.current = connectedDevices.length > 0; }, [connectedDevices]);

  useEffect(() => {
    if (!open) {
      const sid = sessionIdRef.current;
      if (sid && !connectedRef.current) {
        void supabase.rpc("revoke_scanner_session" as any, { p_session_id: sid } as any);
      }
      setPairing(null);
      setSessionId(null);
      setError(null);
      return;
    }
    void openSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (sid && !connectedRef.current) {
        void supabase.rpc("revoke_scanner_session" as any, { p_session_id: sid } as any);
      }
    };
  }, []);

  useEffect(() => {
    if (!pairing) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [pairing]);

  const baseUrl = tryGetPublicAppUrl();
  const url = pairing && baseUrl ? `${baseUrl}/scan/${pairing.token}` : "";

  const isConnected = connectedDevices.length > 0;

  const handleRevoke = async () => {
    setRevoking(true);
    setError(null);
    try {
      const res = await revoke();
      if (!res.ok) setError(res.error || "Failed to disconnect");
      else onOpenChange(false);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" /> Use phone as scanner
          </DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>
        <SessionBody
          isConnected={isConnected}
          loading={loading}
          pairing={pairing}
          url={url}
          secondsLeft={secondsLeft}
          error={error}
          connectedDevices={connectedDevices}
          revoking={revoking}
          onRefreshPairing={() => sessionId && mintPairing(sessionId)}
          onRevoke={handleRevoke}
          onDone={() => onOpenChange(false)}
          lastScanByDevice={lastScanByDevice}
          sessionId={sessionId}
          label={label}
        />
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ Shared body ----------------------------- */

function ScanToTestButton({
  pingPhone,
}: {
  pingPhone: () => Promise<number | null>;
}) {
  const [state, setState] = useState<"idle" | "pinging" | "ok" | "fail">("idle");
  const [rtt, setRtt] = useState<number | null>(null);

  const handle = async () => {
    setState("pinging");
    setRtt(null);
    const result = await pingPhone();
    if (result == null) {
      setState("fail");
    } else {
      setRtt(result);
      setState("ok");
    }
    setTimeout(() => setState("idle"), 2500);
  };

  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
      <Button size="sm" variant="outline" onClick={handle} disabled={state === "pinging"}>
        {state === "pinging" ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Activity className="mr-1 h-3 w-3" />
        )}
        Ping phone
      </Button>
      {state === "ok" && rtt != null && (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
          <CheckCircle2 className="h-3 w-3" /> {rtt} ms
        </span>
      )}
      {state === "fail" && (
        <span className="inline-flex items-center gap-1 text-xs text-red-600">
          <XCircle className="h-3 w-3" /> No response
        </span>
      )}
    </div>
  );
}

function SessionBody({
  isConnected,
  loading,
  pairing,
  url,
  secondsLeft,
  error,
  connectedDevices,
  revoking,
  onRefreshPairing,
  onRevoke,
  onDone,
  pingPhone,
  rttMedianMs,
  lastScanAt,
  lastScanByDevice,
  sessionId,
  label,
}: {
  isConnected: boolean;
  loading: boolean;
  pairing: Pairing | null;
  url: string;
  secondsLeft: number;
  error: string | null;
  connectedDevices: ConnectedScannerDevice[];
  revoking: boolean;
  onRefreshPairing: () => void;
  onRevoke: () => void;
  onDone: () => void;
  pingPhone?: () => Promise<number | null>;
  rttMedianMs?: number | null;
  lastScanAt?: number | null;
  lastScanByDevice?: Record<string, number>;
  sessionId?: string | null;
  label?: string;
}) {
  if (isConnected) {
    const primary = connectedDevices[0];
    const onlineSince = primary?.online_at ? new Date(primary.online_at).toLocaleTimeString() : "—";
    const lastScanLabel = lastScanAt
      ? `${Math.max(0, Math.floor((Date.now() - lastScanAt) / 1000))}s ago`
      : "—";
    const rttLabel = rttMedianMs != null ? `${Math.round(rttMedianMs)} ms` : "—";
    return (
      <div className="space-y-4">
        <Alert className="border-emerald-500/40 bg-emerald-500/5">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <AlertDescription>
            <div className="font-medium">
              {connectedDevices.length === 1
                ? "Mobile scanner connected"
                : `${connectedDevices.length} mobile scanners connected`}
            </div>
          </AlertDescription>
        </Alert>
        {sessionId && (
          <DevicePresenceList
            sessionId={sessionId}
            registerName={label ?? null}
            devices={connectedDevices}
            lastScanByDevice={lastScanByDevice}
          />
        )}
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
          <div className="grid grid-cols-2 gap-y-1.5">
            <span className="text-muted-foreground">Device</span>
            <span className="text-right font-medium">{primary?.device_label || "Mobile device"}</span>
            <span className="text-muted-foreground">Online since</span>
            <span className="text-right font-mono">{onlineSince}</span>
            <span className="text-muted-foreground">Last scan</span>
            <span className="text-right font-mono">{lastScanLabel}</span>
            <span className="text-muted-foreground">RTT (median)</span>
            <span className="text-right font-mono">{rttLabel}</span>
          </div>
          {pingPhone && (
            <ScanToTestButton pingPhone={pingPhone} />
          )}
        </div>
        <div className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          <ScanLine className="mx-auto mb-2 h-6 w-6 opacity-50" />
          Scans will fill the focused barcode field.
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="destructive" onClick={onRevoke} disabled={revoking}>
            {revoking ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Ban className="mr-1 h-3 w-3" />}
            Disconnect
          </Button>
          <Button variant="outline" onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <QRHostMismatchWarning url={url} />
      <div className="flex items-center justify-center rounded-lg border bg-white p-4">
        {loading || !pairing ? (
          <div className="flex h-[220px] w-[220px] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <QRCodeSVG value={url} size={220} level="M" includeMargin={false} />
        )}
      </div>
      {pairing && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            Expires in <span className="font-mono">{secondsLeft}s</span>
          </span>
          <Button variant="ghost" size="sm" onClick={onRefreshPairing} disabled={loading}>
            <RefreshCw className="mr-1 h-3 w-3" /> New code
          </Button>
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
      <ol className="space-y-1 text-xs text-muted-foreground">
        <li>1. Open the camera on your phone.</li>
        <li>2. Point it at the QR code and tap the link.</li>
        <li>3. Allow camera access — scans will land in the focused barcode field.</li>
      </ol>
        <SameDeviceShortcuts pairingToken={pairing?.token ?? null} />
        <TrustedDevicesPanel />
    </div>
  );
}

/* ------------------ Same-device & in-app QR shortcuts ------------------ */
/**
 * Surfaces two affordances when the desk is itself a phone:
 *   - "Pair this device": navigate directly to /scan/<token>, no QR
 *     handoff. The pairing token has already been minted server-side and
 *     is single-use + 60s TTL, so consuming it locally is equivalent to
 *     scanning the QR from another camera.
 *   - "Scan QR with this phone": opens an in-app camera viewfinder so the
 *     user can pair a different desk's QR without leaving the ERP.
 *
 * Hidden on desktops via `useIsLikelyMobile` — neither shortcut makes
 * sense when the desk is a laptop.
 */
function SameDeviceShortcuts({ pairingToken }: { pairingToken: string | null }) {
  const isMobile = useIsLikelyMobile();
  const navigate = useNavigate();
  const [scannerOpen, setScannerOpen] = useState(false);
  if (!isMobile) return null;
  return (
    <>
      <div className="space-y-2 rounded-md border border-dashed border-border bg-muted/20 p-3">
        <div className="text-xs font-medium text-foreground">On this phone?</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant="default"
            size="sm"
            disabled={!pairingToken}
            onClick={() => pairingToken && navigate(`/scan/${pairingToken}`)}
          >
            <Smartphone className="mr-1 h-3 w-3" /> Pair this device
          </Button>
          <Button variant="outline" size="sm" onClick={() => setScannerOpen(true)}>
            <Camera className="mr-1 h-3 w-3" /> Scan QR with phone
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Use "Pair this device" to turn this phone into the scanner. Use
          "Scan QR" to pair a different desk's QR without switching apps.
        </p>
      </div>
      <InAppQrScanner open={scannerOpen} onClose={() => setScannerOpen(false)} />
    </>
  );
}

// =========================================================
// QR host-mismatch warning
//
// Surfaces the most common cause of "phone scanned the QR and just
// opened the website": the QR encodes a host the desk-side operator
// is NOT currently on (legacy env override, stale localStorage
// override, etc.). When that happens the phone reaches a deployment
// where it is not signed in and the auth gate bounces it to /login.
// Documented in docs/audit/2026-06-02-pairing-architecture.md.
// =========================================================
function QRHostMismatchWarning({ url }: { url: string }) {
  const [override, setOverride] = useState<string | null>(null);
  if (!url || typeof window === "undefined") return null;
  let qrHost = "";
  try { qrHost = new URL(url).origin; } catch { return null; }
  const deskHost = window.location.origin;
  if (qrHost === deskHost) return null;
  return (
    <Alert className="border-amber-500/50 bg-amber-500/5">
      <AlertDescription className="text-xs">
        <div className="font-medium text-amber-700 dark:text-amber-400">
          QR points to a different host than this desk
        </div>
        <div className="mt-1 text-muted-foreground">
          QR host: <span className="font-mono">{qrHost}</span><br />
          This desk: <span className="font-mono">{deskHost}</span>
        </div>
        <div className="mt-1 text-muted-foreground">
          The phone will open the QR host, not this one — it must be signed
          in on that host for pairing to complete.
        </div>
        {override !== "applied" && (
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-7"
            onClick={() => {
              try {
                window.localStorage.setItem("pos.public_app_url", deskHost);
                setOverride("applied");
              } catch { /* private mode */ }
            }}
          >
            Use this host for QRs
          </Button>
        )}
        {override === "applied" && (
          <div className="mt-2 text-emerald-600">
            Saved. Close and reopen the dialog to regenerate the QR.
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

// P4b — Trusted Devices admin panel
//
// Lists previously-paired phones (rows from `scanner_device_trust`
// selectable by the current org's admin / cashier roles) and exposes a
// per-device revoke button calling `scanner_revoke_trust`. The phone
// learns about the revoke on its next mount via the silent-reclaim
// failure path (or instantly via `useScannerSessionRevocation` if an
// active session exists).
// =========================================================
function TrustedDevicesPanel() {
  const [rows, setRows] = useState<Array<{
    device_id: string;
    device_label: string | null;
    last_seen_at: string;
    last_reclaimed_at: string | null;
    reclaim_count: number;
    trust_token_prefix: string;
  }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase
      .from("scanner_device_trust" as any)
      .select("device_id,device_label,last_seen_at,last_reclaimed_at,reclaim_count,trust_token_prefix,revoked_at")
      .is("revoked_at", null)
      .order("last_seen_at", { ascending: false })
      .limit(20);
    if (!error && Array.isArray(data)) setRows(data as any);
    setLoaded(true);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const revoke = useCallback(async (device_id: string) => {
    setBusy(device_id);
    const { error } = await supabase.rpc(
      "scanner_revoke_trust" as any,
      { p_device_id: device_id, p_reason: "admin_panel" } as any,
    );
    setBusy(null);
    if (!error) await refresh();
  }, [refresh]);

  if (!loaded || rows.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 text-xs">
      <div className="mb-2 font-medium text-foreground">Trusted devices</div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.device_id} className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground">
                {r.device_label || "Mobile device"}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                token {r.trust_token_prefix}… · reclaims {r.reclaim_count} · last seen{" "}
                {new Date(r.last_seen_at).toLocaleString()}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-destructive hover:text-destructive"
              onClick={() => revoke(r.device_id)}
              disabled={busy === r.device_id}
            >
              {busy === r.device_id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Revoke"}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
