/**
 * MobileScannerDialog — terminal-side QR pairing UI for the
 * phone-as-scanner flow. Mints a 60-second pairing token via the
 * `pos_create_scanner_pairing` RPC, renders a QR code pointing at
 * `/pos/scan/<token>`, and surfaces presence updates from the
 * `usePOSScannerChannel` hook.
 */

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Smartphone, RefreshCw, CheckCircle2, Loader2, ScanLine, Ban } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ConnectedScannerDevice } from "@/hooks/pos/usePOSScannerChannel";
import { tryGetPublicAppUrl } from "@/lib/publicAppUrl";
import { DevicePresenceList } from "@/components/scanner/DevicePresenceList";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registerId: string;
  connectedDevices: ConnectedScannerDevice[];
  lastScanByDevice?: Record<string, number>;
  onRevoke?: () => Promise<{ ok: boolean; count: number; error?: string }> | void;
}

interface Pairing {
  token: string;
  expiresAt: number;
}

export function MobileScannerDialog({ open, onOpenChange, registerId, connectedDevices, lastScanByDevice, onRevoke }: Props) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [revoking, setRevoking] = useState(false);

  const mint = async () => {
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc(
      "pos_create_scanner_pairing" as any,
      { p_register_id: registerId } as any,
    );
    setLoading(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row) {
      setError("No pairing token returned");
      return;
    }
    setPairing({
      token: (row as any).token,
      expiresAt: new Date((row as any).expires_at).getTime(),
    });
  };

  // Auto-mint on open + refresh when expired
  useEffect(() => {
    if (!open) {
      setPairing(null);
      setError(null);
      return;
    }
    void mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Countdown
  useEffect(() => {
    if (!pairing) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
      setSecondsLeft(left);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [pairing]);

  const baseUrl = tryGetPublicAppUrl();
  const url = pairing && baseUrl ? `${baseUrl}/pos/scan/${pairing.token}` : "";

  const isConnected = connectedDevices.length > 0;

  const handleRevoke = async () => {
    if (!onRevoke) return;
    setRevoking(true);
    setError(null);
    try {
      const res = await onRevoke();
      if (res && !res.ok) setError(res.error || "Failed to disconnect");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            Use phone as scanner
          </DialogTitle>
          <DialogDescription>
            Scan this QR code with your phone's camera to turn it into a barcode scanner for this register.
          </DialogDescription>
        </DialogHeader>

        {isConnected ? (
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
            <DevicePresenceList
              sessionId={registerId}
              devices={connectedDevices}
              lastScanByDevice={lastScanByDevice}
            />
            <div className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              <ScanLine className="mx-auto mb-2 h-6 w-6 opacity-50" />
              Scans from the phone will appear in the cart instantly.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="destructive"
                onClick={handleRevoke}
                disabled={revoking || !onRevoke}
              >
                {revoking ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Ban className="mr-1 h-3 w-3" />}
                Disconnect
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">{error}</AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-center rounded-lg border bg-white p-4">
              {loading ? (
                <div className="flex h-[220px] w-[220px] items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : pairing ? (
                <QRCodeSVG value={url} size={220} level="M" includeMargin={false} />
              ) : (
                <div className="flex h-[220px] w-[220px] items-center justify-center text-sm text-muted-foreground">
                  No pairing
                </div>
              )}
            </div>

            {pairing && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  Expires in <span className="font-mono">{secondsLeft}s</span>
                </span>
                <Button variant="ghost" size="sm" onClick={mint} disabled={loading}>
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
              <li>2. Point it at the QR code above and tap the link.</li>
              <li>3. Allow camera access — scans will flow into this terminal.</li>
            </ol>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}