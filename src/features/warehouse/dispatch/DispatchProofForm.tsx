/**
 * Proof-of-dispatch capture form (Phase C).
 *
 * Shared by the desktop Loading Bay and the RF handheld. The component is
 * transport-agnostic on purpose: the desktop shell submits through
 * `useCaptureDispatchProof` (replay-guarded RPC) while the RF shell submits
 * through the offline queue. Both land on `wms_capture_dispatch_proof`,
 * the only sanctioned write path for `wms_dispatch_proofs`.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignatureCanvas } from "@/components/common/SignatureCanvas";
import { MapPin } from "lucide-react";
import type { DispatchProofInput, ManifestProofStatus } from "@/features/warehouse/aggregates/useDomainOperations";

interface Props {
  status?: ManifestProofStatus | null;
  submitting?: boolean;
  compact?: boolean;
  onSubmit: (values: DispatchProofInput) => void;
}

export function DispatchProofForm({ status, submitting, compact, onSubmit }: Props) {
  const [seal, setSeal] = useState(status?.seal_number ?? "");
  const [driver, setDriver] = useState(status?.driver_name ?? "");
  const [driverRef, setDriverRef] = useState("");
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState<string | null>(status?.signature_url ?? null);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);

  const captureGps = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGps({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const canSubmit = !submitting && seal.trim().length > 0 && driver.trim().length > 0 && !!signature;

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      <div className={compact ? "space-y-3" : "min-w-0 grid gap-3 @xl/page:grid-cols-2"}>
        <div>
          <Label>Seal number</Label>
          <Input
            value={seal}
            onChange={(e) => setSeal(e.target.value)}
            placeholder="Seal applied to the trailer"
            className={compact ? "h-12 font-mono" : "font-mono"}
          />
        </div>
        <div>
          <Label>Driver name</Label>
          <Input
            value={driver}
            onChange={(e) => setDriver(e.target.value)}
            placeholder="Who is taking custody"
            className={compact ? "h-12" : undefined}
          />
        </div>
        <div>
          <Label>Driver ID / licence</Label>
          <Input
            value={driverRef}
            onChange={(e) => setDriverRef(e.target.value)}
            placeholder="Optional"
            className={compact ? "h-12" : undefined}
          />
        </div>
        <div className="flex items-end gap-2">
          <Button type="button" variant="outline" onClick={captureGps} disabled={locating} className={compact ? "h-12 w-full" : undefined}>
            <MapPin className="h-4 w-4 mr-2" />
            {gps ? `${gps.lat}, ${gps.lng}` : locating ? "Locating…" : "Capture GPS"}
          </Button>
        </div>
      </div>

      <div>
        <Label>Driver signature</Label>
        <SignatureCanvas onSignatureChange={setSignature} initialSignature={status?.signature_url ?? null} />
      </div>

      <div>
        <Label>Notes</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Optional" />
      </div>

      <Button
        type="button"
        className={compact ? "h-12 w-full" : undefined}
        disabled={!canSubmit}
        onClick={() =>
          onSubmit({
            sealNumber: seal.trim(),
            driverName: driver.trim(),
            driverIdRef: driverRef.trim() || null,
            signatureUrl: signature,
            gpsLat: gps?.lat ?? null,
            gpsLng: gps?.lng ?? null,
            notes: notes.trim() || null,
          })
        }
      >
        {submitting ? "Saving…" : status?.captured ? "Update proof" : "Capture proof"}
      </Button>
      {!canSubmit && !submitting && (
        <p className="text-xs text-muted-foreground">Seal number, driver name and a signature are required.</p>
      )}
    </div>
  );
}
