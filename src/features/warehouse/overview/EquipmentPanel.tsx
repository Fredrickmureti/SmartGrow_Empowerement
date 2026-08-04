/**
 * Equipment health panel — scanners, printers and mobile devices.
 *
 * Projection of `wms_equipment_health`. A warehouse stops when the handheld
 * stops, so device health belongs on the operational home page rather than
 * buried in platform hardware settings — which is still where it is fixed.
 */
import { Link } from "react-router-dom";
import { Printer, ScanLine, Smartphone, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/design-system";
import { DEVICE_HEALTH_LABEL, type EquipmentHealth } from "./contract";

function roleIcon(role: string | null) {
  const r = (role ?? "").toLowerCase();
  if (r.includes("print")) return Printer;
  if (r.includes("scan")) return ScanLine;
  if (r.includes("display") || r.includes("mobile") || r.includes("terminal")) return Smartphone;
  return HelpCircle;
}

export function EquipmentPanel({ equipment }: { equipment: EquipmentHealth | undefined }) {
  if (!equipment || equipment.total === 0) {
    return (
      <EmptyState
        title="No devices registered"
        description="Register scanners and printers to see equipment health here."
      />
    );
  }

  const degraded = equipment.stale + equipment.error + equipment.unknown;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Online</dt>
          <dd className="text-lg font-semibold tabular-nums text-success">{equipment.online}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Silent</dt>
          <dd
            className={cn(
              "text-lg font-semibold tabular-nums",
              equipment.stale + equipment.unknown > 0 && "text-warning",
            )}
          >
            {equipment.stale + equipment.unknown}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Error</dt>
          <dd
            className={cn(
              "text-lg font-semibold tabular-nums",
              equipment.error > 0 && "text-destructive",
            )}
          >
            {equipment.error}
          </dd>
        </div>
      </dl>

      {degraded === 0 ? (
        <p className="text-sm text-muted-foreground">
          All {equipment.total} registered devices reported in recently.
        </p>
      ) : (
        <ul className="space-y-2">
          {equipment.devices.slice(0, 5).map((d) => {
            const Icon = roleIcon(d.role);
            return (
              <li key={d.id} className="flex items-start gap-2 text-sm">
                <Icon
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    d.health === "error" ? "text-destructive" : "text-warning",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{d.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {DEVICE_HEALTH_LABEL[d.health]}
                    {d.last_error ? ` · ${d.last_error}` : ""}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Button asChild variant="ghost" size="sm" className="w-full">
        <Link to="/platform/hardware/devices">Manage devices</Link>
      </Button>
    </div>
  );
}

export default EquipmentPanel;
