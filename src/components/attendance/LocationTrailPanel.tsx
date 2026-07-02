/**
 * LocationTrailPanel — HD map + address + per-fix metadata for an attendance
 * event or clock fix. Frontend-only. Uses OpenStreetMap embed (no API key)
 * and Nominatim for reverse geocoding.
 */
import { MapPin, Copy, ExternalLink, Crosshair } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useReverseGeocode } from "@/hooks/attendance/useReverseGeocode";
import { toast } from "sonner";

export interface LocationFix {
  lat: number;
  lng: number;
  accuracy_m?: number | null;
  capturedAt?: string | null;
  label?: string | null;        // e.g. "Clock in", "Denied attempt"
  decision?: string | null;     // allow/deny/flag
  source?: string | null;       // mobile/web/kiosk
}

export function LocationTrailPanel({ fix, live }: { fix: LocationFix; live?: boolean }) {
  const { data: address, isLoading: addrLoading } = useReverseGeocode(fix.lat, fix.lng);

  const lat = Number(fix.lat);
  const lng = Number(fix.lng);
  // Bounding box ~250m around point for embed zoom
  const d = 0.0025;
  const bbox = `${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}`;
  const mapSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`;
  const osmLink = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;
  const gmapLink = `https://www.google.com/maps?q=${lat},${lng}`;
  const appleLink = `https://maps.apple.com/?ll=${lat},${lng}&q=Captured%20location`;

  const copyCoords = async () => {
    try {
      await navigator.clipboard.writeText(`${lat}, ${lng}`);
      toast.success("Coordinates copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="relative">
        <iframe
          title="Captured location"
          src={mapSrc}
          className="w-full h-56 border-0"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups"
          loading="lazy"
        />
        {live && (
          <span className="absolute top-2 left-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/90 text-white text-[10px] font-semibold">
            <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
            LIVE
          </span>
        )}
        <a
          href={osmLink}
          target="_blank"
          rel="noreferrer noopener"
          className="absolute bottom-2 right-2 text-[10px] bg-background/90 px-1.5 py-0.5 rounded border"
        >
          View larger map
        </a>
      </div>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0 text-sm">
            <p className="font-medium truncate" title={address ?? undefined}>
              {addrLoading ? "Resolving address…" : (address ?? "Address unavailable")}
            </p>
            <p className="text-xs text-muted-foreground font-mono tabular-nums">
              {lat.toFixed(6)}, {lng.toFixed(6)}
              {fix.accuracy_m != null && (
                <span className="ml-2 inline-flex items-center gap-1">
                  <Crosshair className="h-3 w-3" /> ±{Math.round(Number(fix.accuracy_m))}m
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {fix.label && <Badge variant="outline" className="text-[10px]">{fix.label}</Badge>}
          {fix.decision && (
            <Badge
              variant={
                fix.decision === "deny" ? "destructive" : fix.decision === "flag" ? "outline" : "secondary"
              }
              className="text-[10px] capitalize"
            >
              {fix.decision}
            </Badge>
          )}
          {fix.source && <Badge variant="outline" className="text-[10px]">{fix.source}</Badge>}
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={copyCoords}>
            <Copy className="h-3 w-3 mr-1" /> Copy
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
            <a href={gmapLink} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="h-3 w-3 mr-1" /> Google Maps
            </a>
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
            <a href={appleLink} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="h-3 w-3 mr-1" /> Apple Maps
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
